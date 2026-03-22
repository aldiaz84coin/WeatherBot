// src/prediction/position.ts
// Construye la posición de 2 tokens a partir de una temperatura predicha
//
// Lógica de selección:
//   token_a = Math.ceil(ensemble_temp)      ← inmediato superior
//   token_b = Math.ceil(ensemble_temp) + 1  ← siguiente
//
// Presupuesto: 0.40 USDC por token = 0.80 USDC total

import { buildTokenSlug } from '../polymarket/slugs'
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
  tempCelsius:  number       // temperatura exacta del token (entera)
  slug:         string       // slug de Polymarket
  costUsdc:     number       // presupuesto asignado
  priceAtBuy:   number | null  // precio YES en Polymarket al momento del cálculo
  shares:       number | null  // costUsdc / priceAtBuy
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

  const defs: { slot: TokenSlot; tempCelsius: number }[] = [
    { slot: 'a', tempCelsius: ceilTemp },
    { slot: 'b', tempCelsius: ceilTemp + 1 },
  ]

  const tokens: Record<TokenSlot, TokenPosition> = {} as any
  let marketAvailable = false

  for (const def of defs) {
    const slug     = buildTokenSlug(targetDate, def.tempCelsius)
    const costUsdc = BUDGET[def.slot]

    let priceAtBuy: number | null = null
    let shares:     number | null = null

    try {
      priceAtBuy = await gamma.getTokenPrice(slug)
      if (priceAtBuy !== null && priceAtBuy > 0) {
        shares = parseFloat((costUsdc / priceAtBuy).toFixed(4))
        marketAvailable = true
      }
    } catch {
      // Mercado no disponible aún — se reintentará en el job de apertura
    }

    tokens[def.slot] = {
      slot:        def.slot,
      tempCelsius: def.tempCelsius,
      slug,
      costUsdc,
      priceAtBuy,
      shares,
    }
  }

  return {
    targetDate,
    ensembleTemp,
    tokenA:          tokens.a,
    tokenB:          tokens.b,
    totalCostUsdc:   TOTAL_BUDGET,
    marketAvailable,
  }
}
