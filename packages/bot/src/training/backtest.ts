// src/training/backtest.ts
// ============================================================
// ⭐ FASE 1 — ALGORITMO DE BACKTEST
//
// OBJETIVO: Encontrar la combinación de 3 tokens de Polymarket
// cuya compra conjunta (coste total < 0.80 USDC) habría
// acertado en ≥ 90% de los días del último año.
//
// Un día "acierta" cuando al menos uno de los tres tokens
// comprados (pred-1°, pred°, pred+1°) resuelve en YES.
// ============================================================

import { format, subDays, eachDayOfInterval } from 'date-fns'
import { supabase } from '../db/supabase'
import { WeatherSourceManager } from '../sources'
import { GammaClient, buildDaySlug } from '../polymarket/gamma'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface BacktestDay {
  date: string
  sourceTemps: Record<string, number>
  ensembleTemp: number             // predicción del ensemble para ese día
  actualTemp: number               // temperatura real (ground truth)
  tokenLow: number                 // ensembleTemp - 1
  tokenMid: number                 // ensembleTemp
  tokenHigh: number                // ensembleTemp + 1
  hit: boolean                     // ¿algún token acertó?
  // ¿qué token habría acertado?
  winningOffset: -1 | 0 | 1 | null
}

export interface BacktestResult {
  totalDays: number
  hitCount: number
  hitRate: number                  // 0.0 – 1.0  ⭐ objetivo: >= 0.90
  passed: boolean                  // hitRate >= TARGET_HIT_RATE
  dayResults: BacktestDay[]
  ensembleWeights: Record<string, number>
  rmseBySource: Record<string, number>
  biasBreakdown: {
    overestimated: number          // días en que pred > real (fuera de rango)
    underestimated: number         // días en que pred < real (fuera de rango)
  }
}

// ─── Configuración ────────────────────────────────────────────────────────────

const TARGET_HIT_RATE = 0.90      // ⭐ umbral de validación
const TOKEN_WINDOW    = 1          // ±N grados alrededor de la predicción
const DAILY_BUDGET    = 0.80       // USDC máximo por día (los 3 tokens juntos)
const COST_DISTRIBUTION = {
  low:  0.20,                      // token pred-1°
  mid:  0.40,                      // token pred
  high: 0.20,                      // token pred+1°
}

// Validación: la suma nunca puede superar DAILY_BUDGET
const totalCost = Object.values(COST_DISTRIBUTION).reduce((a, b) => a + b, 0)
if (totalCost >= DAILY_BUDGET) {
  throw new Error(`BUG: cost distribution sums to ${totalCost}, must be < ${DAILY_BUDGET}`)
}

// ─── Fuente de verdad para temperaturas reales ────────────────────────────────

async function getGroundTruth(date: string, manager: WeatherSourceManager): Promise<number> {
  // Open-Meteo Archive (ERA5-land) como ground truth principal
  const historicals = await manager.getHistoricalForDate(date)
  const sources = ['open-meteo', 'copernicus', 'aemet', 'weatherapi', 'visual-crossing']

  for (const slug of sources) {
    if (historicals[slug] !== undefined) return historicals[slug]
  }

  throw new Error(`No ground truth available for ${date}`)
}

// ─── Algoritmo principal de backtest ─────────────────────────────────────────

export async function runBacktest(
  manager: WeatherSourceManager,
  daysBack = 365
): Promise<BacktestResult> {
  const today = new Date()
  const endDate = subDays(today, 1)              // ayer como último día
  const startDate = subDays(today, daysBack)

  const days = eachDayOfInterval({ start: startDate, end: endDate })

  console.log(`\n⭐ Iniciando backtest: ${days.length} días`)
  console.log(`   Objetivo: hit rate ≥ ${TARGET_HIT_RATE * 100}%`)
  console.log(`   Presupuesto diario: < ${DAILY_BUDGET} USDC / día\n`)

  const dayResults: BacktestDay[] = []
  const sourceErrors: Record<string, number[]> = {}
  let hitCount = 0
  let overestimated = 0
  let underestimated = 0

  for (let i = 0; i < days.length; i++) {
    const targetDate = format(days[i], 'yyyy-MM-dd')
    const prevDate   = format(subDays(days[i], 1), 'yyyy-MM-dd')

    try {
      // 1. Lo que las fuentes habrían predicho el DÍA ANTERIOR para targetDate
      const forecastTemps = await manager.getHistoricalForDate(prevDate)
      // (Nota: en backtest usamos histórico del día anterior como proxy de forecast)
      // En producción real, usaremos getForecast() desde el día anterior

      // 2. Temperatura real del día objetivo (ground truth)
      const actualTemp = await getGroundTruth(targetDate, manager)

      // 3. Predicción del ensemble para ese día
      const ensembleTemp = manager['computeWeightedAverage']
        ? (manager as any).computeWeightedAverage(forecastTemps)
        : computeSimpleWeightedAverage(forecastTemps, manager)

      // 4. Evaluar si algún token habría acertado
      const tokenLow  = Math.round(ensembleTemp) - TOKEN_WINDOW
      const tokenMid  = Math.round(ensembleTemp)
      const tokenHigh = Math.round(ensembleTemp) + TOKEN_WINDOW
      const actualRounded = Math.round(actualTemp)

      const hit = [tokenLow, tokenMid, tokenHigh].includes(actualRounded)
      const winningOffset = hit
        ? (actualRounded === tokenLow ? -1 : actualRounded === tokenMid ? 0 : 1)
        : null

      if (!hit) {
        if (actualRounded < tokenLow) underestimated++   // predijimos demasiado alto
        else overestimated++                              // predijimos demasiado bajo
      }

      // 5. Calcular error por fuente
      for (const [slug, temp] of Object.entries(forecastTemps)) {
        if (!sourceErrors[slug]) sourceErrors[slug] = []
        sourceErrors[slug].push(Math.abs(temp - actualTemp))
      }

      if (hit) hitCount++

      dayResults.push({
        date: targetDate,
        sourceTemps: forecastTemps,
        ensembleTemp,
        actualTemp,
        tokenLow,
        tokenMid,
        tokenHigh,
        hit,
        winningOffset,
      })

      // Progress log cada 30 días
      if ((i + 1) % 30 === 0) {
        const runningRate = (hitCount / (i + 1) * 100).toFixed(1)
        console.log(`   Día ${i + 1}/${days.length} — hit rate: ${runningRate}%`)
      }

    } catch (err) {
      console.warn(`   ⚠️  ${targetDate}: ${(err as Error).message}`)
    }
  }

  // 6. Calcular RMSE por fuente
  const rmseBySource: Record<string, number> = {}
  for (const [slug, errors] of Object.entries(sourceErrors)) {
    const mse = errors.reduce((a, b) => a + b * b, 0) / errors.length
    rmseBySource[slug] = Math.sqrt(mse)
  }

  const hitRate = hitCount / dayResults.length

  const result: BacktestResult = {
    totalDays: dayResults.length,
    hitCount,
    hitRate,
    passed: hitRate >= TARGET_HIT_RATE,
    dayResults,
    ensembleWeights: {},  // se rellena por el optimizador
    rmseBySource,
    biasBreakdown: { overestimated, underestimated },
  }

  // 7. Log de resultados
  console.log('\n─────────────────────────────────────────')
  console.log('⭐ RESULTADO DEL BACKTEST')
  console.log(`   Días evaluados:  ${result.totalDays}`)
  console.log(`   Aciertos:        ${result.hitCount} (${(hitRate * 100).toFixed(1)}%)`)
  console.log(`   Objetivo (≥90%): ${result.passed ? '✅ SUPERADO' : '❌ NO SUPERADO'}`)
  console.log(`   Sobreestimados:  ${overestimated}`)
  console.log(`   Subestimados:    ${underestimated}`)
  console.log('\n   RMSE por fuente:')
  for (const [slug, rmse] of Object.entries(rmseBySource).sort(([, a], [, b]) => a - b)) {
    console.log(`     ${slug.padEnd(20)} ${rmse.toFixed(3)} °C`)
  }
  console.log('─────────────────────────────────────────\n')

  return result
}

// ─── Guardar resultado en Supabase ────────────────────────────────────────────

export async function saveBacktestResult(result: BacktestResult) {
  const { error } = await supabase.from('training_runs').insert({
    days_tested:    result.totalDays,
    hit_rate:       result.hitRate,
    best_ensemble:  result.ensembleWeights,
    config: {
      token_window:      TOKEN_WINDOW,
      daily_budget:      DAILY_BUDGET,
      cost_distribution: COST_DISTRIBUTION,
      target_hit_rate:   TARGET_HIT_RATE,
    },
    notes: result.passed
      ? `✅ Superó el objetivo del ${TARGET_HIT_RATE * 100}%`
      : `❌ Hit rate ${(result.hitRate * 100).toFixed(1)}% — requiere optimización`,
  })

  if (error) console.error('Error guardando backtest:', error)
  else console.log('✅ Resultado del backtest guardado en Supabase')
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function computeSimpleWeightedAverage(
  temps: Record<string, number>,
  _manager: WeatherSourceManager
): number {
  const values = Object.values(temps).filter((v) => v !== undefined && !isNaN(v))
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ─── Entrypoint CLI ───────────────────────────────────────────────────────────

if (require.main === module) {
  ;(async () => {
    const { setupManager } = await import('./setup')
    const manager = await setupManager()
    const result = await runBacktest(manager, 365)
    await saveBacktestResult(result)
  })()
}
