// src/training/token-optimizer.ts
// ============================================================
// Optimizador de selección de tokens de Polymarket
//
// LÓGICA CENTRAL:
// Dado que compramos tokens de temperatura donde:
//   - Exactamente 1 token resolverá en YES (el de la temperatura real)
//   - Todos los demás resuelven en 0
//   - Un token en YES paga 1.0 USDC por token comprado
//
// Si la suma de precios de los tokens seleccionados < 0.80 USDC,
// la ganancia mínima garantizada es: 1.0 - suma_precios > 0.20 USDC
//
// ESTRATEGIA: Seleccionar tokens que cubran la temperatura predicha
// (centrada en la predicción del ensemble) con el menor coste posible,
// maximizando el número de temperaturas cubiertas.
// ============================================================

import type { TemperatureToken, DayMarkets } from '../polymarket/market-discovery'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TokenSelection {
  tokens: TemperatureToken[]        // tokens seleccionados, ordenados por temperatura
  totalCost: number                 // suma de precios (SIEMPRE < budget)
  coveredTemps: number[]            // temperaturas cubiertas
  centerTemp: number                // temperatura central (predicción redondeada)
  minProfit: number                 // ganancia mínima = 1.0 - totalCost (si alguno gana)
  coverageRange: { min: number; max: number }  // rango cubierto
}

export interface SimulationResult {
  selection: TokenSelection
  actualTemp: number | null
  won: boolean | null              // null si no hay dato real
  winningTemp: number | null
  profit: number | null            // ganancia/pérdida real (null si pendiente)
}

// ─── Configuración ────────────────────────────────────────────────────────────

const DEFAULT_BUDGET = 0.80
const MIN_TOKEN_PRICE = 0.01   // ignorar tokens casi imposibles
const MAX_TOKEN_PRICE = 0.98   // ignorar tokens casi seguros (poca ganancia)

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Selecciona el conjunto óptimo de tokens para una fecha dada.
 *
 * Estrategia: partiendo del token más cercano a la predicción,
 * añade tokens adyacentes (por distancia a la predicción) mientras
 * la suma de precios se mantenga < budget.
 *
 * Garantía: si ANY token seleccionado resuelve YES → beneficio de al menos (1 - totalCost).
 */
export function selectOptimalTokens(
  markets: DayMarkets,
  predictedTemp: number,
  budget = DEFAULT_BUDGET
): TokenSelection | null {
  if (!markets.available || markets.tokens.length === 0) return null

  // Filtrar tokens dentro del rango de precio útil
  const validTokens = markets.tokens.filter(
    t => t.price >= MIN_TOKEN_PRICE && t.price <= MAX_TOKEN_PRICE
  )

  if (validTokens.length === 0) return null

  const center = Math.round(predictedTemp)

  // Ordenar por distancia a la predicción (más cercanos primero)
  const byDistance = [...validTokens].sort((a, b) => {
    const da = Math.abs(a.tempCelsius - center)
    const db = Math.abs(b.tempCelsius - center)
    if (da !== db) return da - db
    // Empate: preferir el token más bajo (sesgo conservador)
    return a.tempCelsius - b.tempCelsius
  })

  // Selección greedy: añadir tokens mientras no se supere el budget
  const selected: TemperatureToken[] = []
  let totalCost = 0

  for (const token of byDistance) {
    const newTotal = totalCost + token.price
    if (newTotal >= budget) continue  // este token nos haría superar el budget
    selected.push(token)
    totalCost += token.price
  }

  if (selected.length === 0) return null

  // Ordenar por temperatura para presentación
  selected.sort((a, b) => a.tempCelsius - b.tempCelsius)

  const coveredTemps = selected.map(t => t.tempCelsius)
  const totalCostRounded = parseFloat(totalCost.toFixed(4))

  return {
    tokens: selected,
    totalCost: totalCostRounded,
    coveredTemps,
    centerTemp: center,
    minProfit: parseFloat((1.0 - totalCostRounded).toFixed(4)),
    coverageRange: {
      min: Math.min(...coveredTemps),
      max: Math.max(...coveredTemps),
    },
  }
}

/**
 * Evalúa el resultado de una selección dado el dato real.
 */
export function evaluateSelection(
  selection: TokenSelection,
  actualTemp: number
): SimulationResult['profit'] {
  const actualRounded = Math.round(actualTemp)
  const won = selection.coveredTemps.includes(actualRounded)
  // Si ganamos: recibimos 1.0 USDC, pagamos totalCost
  // Si perdemos: pagamos totalCost, no recibimos nada
  return won
    ? parseFloat((1.0 - selection.totalCost).toFixed(4))
    : parseFloat((-selection.totalCost).toFixed(4))
}

/**
 * Simula el resultado de una selección (versión completa).
 */
export function simulateDay(
  markets: DayMarkets,
  predictedTemp: number,
  budget = DEFAULT_BUDGET
): SimulationResult | null {
  const selection = selectOptimalTokens(markets, predictedTemp, budget)
  if (!selection) return null

  const actualTemp = markets.resolvedTemp !== null
    ? markets.resolvedTemp
    : null

  const won = actualTemp !== null
    ? selection.coveredTemps.includes(Math.round(actualTemp))
    : null

  const profit = won !== null
    ? (won ? 1.0 - selection.totalCost : -selection.totalCost)
    : null

  return {
    selection,
    actualTemp: markets.resolvedTemp,
    won,
    winningTemp: markets.resolvedTemp,
    profit: profit !== null ? parseFloat(profit.toFixed(4)) : null,
  }
}

// ─── Análisis de una serie de días ───────────────────────────────────────────

export interface BacktestDaySummary {
  date: string
  predictedTemp: number
  actualTemp: number | null
  selection: TokenSelection | null
  won: boolean | null
  profit: number | null
  marketAvailable: boolean
  tokenCount: number
  coverage: { min: number; max: number } | null
}

export function summarizeDayResult(
  date: string,
  predictedTemp: number,
  markets: DayMarkets,
  budget = DEFAULT_BUDGET
): BacktestDaySummary {
  const sim = simulateDay(markets, predictedTemp, budget)

  return {
    date,
    predictedTemp,
    actualTemp: markets.resolvedTemp,
    selection: sim?.selection ?? null,
    won: sim?.won ?? null,
    profit: sim?.profit ?? null,
    marketAvailable: markets.available,
    tokenCount: sim?.selection.tokens.length ?? 0,
    coverage: sim?.selection.coverageRange ?? null,
  }
}

/**
 * Análisis del criterio 90%: dado un array de resultados de días,
 * calcula las métricas clave.
 */
export function analyzeResults(days: BacktestDaySummary[]): {
  totalDays: number
  daysWithMarket: number
  resolvedDays: number
  wins: number
  hitRate: number
  passed: boolean
  totalProfit: number
  avgProfit: number
  avgTokensPerDay: number
  avgCoverage: number
} {
  const withMarket = days.filter(d => d.marketAvailable)
  const resolved = days.filter(d => d.won !== null)
  const wins = days.filter(d => d.won === true)
  const hitRate = resolved.length > 0 ? wins.length / resolved.length : 0
  const totalProfit = days.reduce((sum, d) => sum + (d.profit ?? 0), 0)
  const avgTokens = withMarket.length > 0
    ? withMarket.reduce((sum, d) => sum + d.tokenCount, 0) / withMarket.length
    : 0
  const avgCoverage = withMarket.filter(d => d.coverage).length > 0
    ? withMarket.reduce((sum, d) => {
        if (!d.coverage) return sum
        return sum + (d.coverage.max - d.coverage.min + 1)
      }, 0) / withMarket.filter(d => d.coverage).length
    : 0

  return {
    totalDays: days.length,
    daysWithMarket: withMarket.length,
    resolvedDays: resolved.length,
    wins: wins.length,
    hitRate: parseFloat(hitRate.toFixed(4)),
    passed: hitRate >= 0.90,
    totalProfit: parseFloat(totalProfit.toFixed(4)),
    avgProfit: resolved.length > 0
      ? parseFloat((totalProfit / resolved.length).toFixed(4))
      : 0,
    avgTokensPerDay: parseFloat(avgTokens.toFixed(1)),
    avgCoverage: parseFloat(avgCoverage.toFixed(1)),
  }
}
