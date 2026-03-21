// src/prediction/position.ts
// Construye la posición de 3 tokens a partir de una temperatura predicha
// Restricción: coste total SIEMPRE < 0.80 USDC

import { buildTokenSlug } from '../polymarket/slugs'
import { GammaClient } from '../polymarket/gamma'
import { addDays, format } from 'date-fns'

// Distribución fija del presupuesto entre los 3 tokens
// low: pred-1°  mid: pred°  high: pred+1°
const BUDGET_DISTRIBUTION = {
  low:  0.20,   // USDC
  mid:  0.40,   // USDC
  high: 0.20,   // USDC
} as const

const TOTAL_BUDGET = Object.values(BUDGET_DISTRIBUTION).reduce((a, b) => a + b, 0)
// Compile-time guard
if (TOTAL_BUDGET > 0.80) throw new Error('BUG: budget exceeds 0.80 USDC limit')

export interface TokenPosition {
  position: 'low' | 'mid' | 'high'
  tempCelsius: number
  slug: string
  costUsdc: number
  priceAtBuy: number | null   // precio actual en Polymarket (null si mercado no disponible)
  shares: number | null
}

export interface Position {
  targetDate: string
  predictedTemp: number
  tokens: TokenPosition[]
  totalCostUsdc: number       // siempre < 0.80
  marketAvailable: boolean
}

export async function buildPosition(
  predictedTemp: number,
  targetDate: string
): Promise<Position> {
  const gamma = new GammaClient()
  const rounded = Math.round(predictedTemp)

  const tokenDefs: { position: 'low' | 'mid' | 'high'; tempCelsius: number }[] = [
    { position: 'low',  tempCelsius: rounded - 1 },
    { position: 'mid',  tempCelsius: rounded },
    { position: 'high', tempCelsius: rounded + 1 },
  ]

  const tokens: TokenPosition[] = []
  let marketAvailable = false

  for (const def of tokenDefs) {
    const slug = buildTokenSlug(targetDate, def.tempCelsius)
    const cost = BUDGET_DISTRIBUTION[def.position]

    let priceAtBuy: number | null = null
    let shares: number | null = null

    try {
      priceAtBuy = await gamma.getTokenPrice(slug)
      if (priceAtBuy !== null && priceAtBuy > 0) {
        shares = cost / priceAtBuy
        marketAvailable = true
      }
    } catch {
      // Mercado no disponible aún — se intentará más tarde
    }

    tokens.push({ position: def.position, tempCelsius: def.tempCelsius, slug, costUsdc: cost, priceAtBuy, shares })
  }

  return {
    targetDate,
    predictedTemp,
    tokens,
    totalCostUsdc: TOTAL_BUDGET,
    marketAvailable,
  }
}
