// src/prediction/position.ts
// Construye la posición de 2 tokens a partir de una temperatura predicha
//
// Lógica de selección:
//   token_a = Math.ceil(ensemble_temp)      ← inmediato superior
//   token_b = Math.ceil(ensemble_temp) + 1  ← siguiente
//
// Presupuesto: 0.40 USDC por token = 0.80 USDC total
//
// Mecanismo de precios: igual que el dashboard
//   → llama a /events?slug=<daySlug> y extrae los tokens del resultado
//   → NO construye slugs de tokens individuales ni llama a /markets?slug=...

import { GammaClient } from '../polymarket/gamma'

// ─── Presupuesto ──────────────────────────────────────────────────────────────

export const BUDGET = {
  a: 0.40,  // ceil(pred)
  b: 0.40,  // ceil(pred) + 1
} as const

export const TOTAL_BUDGET = BUDGET.a + BUDGET.b  // 0.80 USDC

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type TokenSlot = 'a' | 'b'

export interface TokenPosition {
  slot:         TokenSlot
  tempCelsius:  number        // temperatura exacta del token (entera)
  slug:         string        // slug del sub-mercado de Polymarket
  tokenId:      string        // CLOB token ID (para órdenes reales)
  label:        string        // "18°C" | "14°C or below"
  costUsdc:     number        // presupuesto asignado
  priceAtBuy:   number | null // precio YES en el momento del cálculo
  shares:       number | null // costUsdc / priceAtBuy
}

export interface TwoTokenPosition {
  targetDate:       string
  ensembleTemp:     number          // temperatura predicha (puede tener decimal)
  tokenA:           TokenPosition   // ceil(pred)
  tokenB:           TokenPosition   // ceil(pred) + 1
  totalCostUsdc:    number          // siempre 0.80
  marketAvailable:  boolean
}

// ─── Construcción de la posición ─────────────────────────────────────────────

export async function buildPosition(
  ensembleTemp: number,
  targetDate: string
): Promise<TwoTokenPosition> {
  const gamma = new GammaClient()

  // ceil: si pred = 32.0 → token_a = 32; si pred = 32.1 → token_a = 33
  const ceilTemp = Math.ceil(ensembleTemp)
  const tempsNeeded = [ceilTemp, ceilTemp + 1] as const

  // ── Obtener todos los tokens del día en una sola llamada (igual que dashboard)
  let dayTokens: Awaited<ReturnType<typeof gamma.getTokensForDate>>
  try {
    dayTokens = await gamma.getTokensForDate(targetDate)
  } catch {
    dayTokens = { available: false, tokens: [], resolvedTemp: null }
  }

  const slots: TokenSlot[] = ['a', 'b']
  const tokens: Record<TokenSlot, TokenPosition> = {} as any
  let marketAvailable = false

  for (let i = 0; i < 2; i++) {
    const slot       = slots[i]
    const temp       = tempsNeeded[i]
    const costUsdc   = BUDGET[slot]

    // Buscar el token exacto por temperatura dentro del resultado del evento
    const match = dayTokens.tokens.find(t => t.tempCelsius === temp)

    const priceAtBuy = match?.price && match.price > 0 ? match.price : null
    const shares     = priceAtBuy ? parseFloat((costUsdc / priceAtBuy).toFixed(4)) : null

    if (priceAtBuy) marketAvailable = true

    tokens[slot] = {
      slot,
      tempCelsius: temp,
      slug:        match?.slug    ?? '',
      tokenId:     match?.tokenId ?? '',
      label:       match?.label   ?? `${temp}°C`,
      costUsdc,
      priceAtBuy,
      shares,
    }
  }

  return {
    targetDate,
    ensembleTemp,
    tokenA:         tokens.a,
    tokenB:         tokens.b,
    totalCostUsdc:  TOTAL_BUDGET,
    marketAvailable,
  }
}
