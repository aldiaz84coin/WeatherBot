// src/training/real-backtest.ts
// ============================================================
// ⭐ BACKTEST CON DATOS REALES
//
// Ejecuta el backtest usando:
//   1. Datos reales de fuentes meteorológicas (ensemble)
//   2. Datos reales de Polymarket (tokens disponibles, precios reales)
//   3. Temperaturas reales como ground truth (Copernicus/Open-Meteo)
//
// Para cada día histórico:
//   a) Obtiene la predicción del ensemble (fuentes del día anterior)
//   b) Busca los tokens disponibles en Polymarket para ese día
//   c) Selecciona el conjunto óptimo (suma < budget)
//   d) Evalúa si algún token ganó
//
// Los resultados se guardan en training_runs y backtest_logs.
// ============================================================

import 'dotenv/config'
import { format, subDays, eachDayOfInterval, parseISO } from 'date-fns'
import { supabase } from '../db/supabase'
import { WeatherSourceManager } from '../sources'
import { MarketDiscovery } from '../polymarket/market-discovery'
import { summarizeDayResult, analyzeResults, type BacktestDaySummary } from './token-optimizer'
import type { BacktestResult } from './backtest'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RealBacktestConfig {
  startDate: string          // YYYY-MM-DD
  endDate: string            // YYYY-MM-DD
  budget: number             // USDC (default 0.80)
  activeSources: string[]    // slugs de fuentes activas
  jobId?: string             // UUID del backtest_job (para logs en tiempo real)
}

export interface RealBacktestResult {
  config: RealBacktestConfig
  totalDays: number
  daysWithMarket: number
  resolvedDays: number
  wins: number
  hitRate: number
  passed: boolean
  totalProfit: number
  avgProfit: number
  avgTokensPerDay: number
  dayResults: BacktestDaySummary[]
  rmseBySource: Record<string, number>
  startedAt: string
  finishedAt: string
  durationSeconds: number
}

// ─── Logger hacia Supabase ────────────────────────────────────────────────────

class BacktestLogger {
  constructor(private jobId: string | undefined) {}

  async log(level: 'info' | 'warn' | 'error' | 'success', message: string, data?: object) {
    console.log(`[${level.toUpperCase()}] ${message}`, data ?? '')
    if (!this.jobId) return

    try {
      await supabase.from('backtest_logs').insert({
        job_id: this.jobId,
        level,
        message,
        data: data ?? null,
      })
    } catch {
      // No interrumpir el backtest por errores de logging
    }
  }

  info = (msg: string, data?: object) => this.log('info', msg, data)
  warn = (msg: string, data?: object) => this.log('warn', msg, data)
  error = (msg: string, data?: object) => this.log('error', msg, data)
  success = (msg: string, data?: object) => this.log('success', msg, data)
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function runRealBacktest(
  manager: WeatherSourceManager,
  config: RealBacktestConfig
): Promise<RealBacktestResult> {
  const logger = new BacktestLogger(config.jobId)
  const discovery = new MarketDiscovery()
  const startedAt = new Date().toISOString()

  await logger.info('🚀 Iniciando backtest con datos reales', {
    startDate: config.startDate,
    endDate: config.endDate,
    budget: config.budget,
    sources: config.activeSources,
  })

  // Marcar job como running
  if (config.jobId) {
    await supabase
      .from('backtest_jobs')
      .update({ status: 'running', started_at: startedAt })
      .eq('id', config.jobId)
  }

  const days = eachDayOfInterval({
    start: parseISO(config.startDate),
    end: parseISO(config.endDate),
  })

  await logger.info(`📅 Días a evaluar: ${days.length}`)

  const dayResults: BacktestDaySummary[] = []
  const sourceErrors: Record<string, number[]> = {}
  let daysWithMarket = 0

  // Prefetch de mercados en background (cachea en Supabase)
  await logger.info('🔍 Pre-cargando datos de Polymarket...')

  for (let i = 0; i < days.length; i++) {
    const targetDate = format(days[i], 'yyyy-MM-dd')
    const prevDate = format(subDays(days[i], 1), 'yyyy-MM-dd')

    try {
      // 1. Predicción del ensemble (usando fuentes del día anterior como proxy)
      const forecastTemps = await manager.getHistoricalForDate(prevDate)
      const sourceCount = Object.keys(forecastTemps).length

      if (sourceCount === 0) {
        await logger.warn(`${targetDate}: ninguna fuente devolvió datos`)
        continue
      }

      // Calcular predicción del ensemble
      const ensembleTemp = computeWeightedAverage(forecastTemps, manager)

      // 2. Obtener temperatura real del día objetivo
      let actualTemp: number | null = null
      try {
        const historicals = await manager.getHistoricalForDate(targetDate)
        // Usar open-meteo o copernicus como ground truth
        actualTemp = historicals['open-meteo'] ?? historicals['copernicus'] ?? null
        if (actualTemp === null && Object.values(historicals).length > 0) {
          actualTemp = Object.values(historicals)[0]
        }
      } catch {
        // Sin ground truth: usaremos lo que devuelva Polymarket (temperatura resuelta)
      }

      // 3. Obtener mercados reales de Polymarket para ese día
      const markets = await discovery.getMarketsForDate(targetDate, true)

      if (markets.available) {
        daysWithMarket++
      }

      // Si Polymarket no tiene el ground truth pero nosotros sí lo tenemos,
      // crear un mercado sintético para el backtest (modo mixto)
      if (!markets.available && actualTemp !== null) {
        // No hay mercado Polymarket — registrar como día sin mercado
        const syntheticDay: BacktestDaySummary = {
          date: targetDate,
          predictedTemp: ensembleTemp,
          actualTemp,
          selection: null,
          won: null,
          profit: null,
          marketAvailable: false,
          tokenCount: 0,
          coverage: null,
        }
        dayResults.push(syntheticDay)
        continue
      }

      // 4. Seleccionar tokens y evaluar resultado
      const dayResult = summarizeDayResult(targetDate, ensembleTemp, markets, config.budget)

      // Override actualTemp con ground truth si Polymarket no lo tiene
      if (dayResult.actualTemp === null && actualTemp !== null) {
        dayResult.actualTemp = actualTemp
        // Re-evaluar won con el ground truth propio
        if (dayResult.selection) {
          const actualRounded = Math.round(actualTemp)
          dayResult.won = dayResult.selection.coveredTemps.includes(actualRounded)
          dayResult.profit = dayResult.won
            ? parseFloat((1.0 - dayResult.selection.totalCost).toFixed(4))
            : parseFloat((-dayResult.selection.totalCost).toFixed(4))
        }
      }

      dayResults.push(dayResult)

      // 5. Calcular error de fuentes vs ground truth
      if (actualTemp !== null) {
        for (const [slug, temp] of Object.entries(forecastTemps)) {
          if (!sourceErrors[slug]) sourceErrors[slug] = []
          sourceErrors[slug].push(Math.abs(temp - actualTemp))
        }
      }

      // Log de progreso cada 15 días
      if ((i + 1) % 15 === 0 || i === days.length - 1) {
        const stats = analyzeResults(dayResults)
        await logger.info(
          `Progreso: ${i + 1}/${days.length} días — hit rate: ${(stats.hitRate * 100).toFixed(1)}% — mercados disponibles: ${daysWithMarket}`,
          { day: i + 1, total: days.length, hitRate: stats.hitRate }
        )
      }

    } catch (err) {
      await logger.warn(`${targetDate}: error — ${(err as Error).message}`)
    }

    // Rate limiting suave para no saturar las APIs
    await new Promise(r => setTimeout(r, 50))
  }

  // ─── Resultados finales ──────────────────────────────────────

  const finishedAt = new Date().toISOString()
  const durationSeconds = Math.round(
    (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
  )

  // RMSE por fuente
  const rmseBySource: Record<string, number> = {}
  for (const [slug, errors] of Object.entries(sourceErrors)) {
    const mse = errors.reduce((a, b) => a + b * b, 0) / errors.length
    rmseBySource[slug] = parseFloat(Math.sqrt(mse).toFixed(3))
  }

  const stats = analyzeResults(dayResults)

  const result: RealBacktestResult = {
    config,
    ...stats,
    daysWithMarket,
    dayResults,
    rmseBySource,
    startedAt,
    finishedAt,
    durationSeconds,
  }

  await logger.success(
    `✅ Backtest completado: ${stats.wins}/${stats.resolvedDays} días ganados (${(stats.hitRate * 100).toFixed(1)}%)`,
    {
      hitRate: stats.hitRate,
      passed: stats.passed,
      totalProfit: stats.totalProfit,
      daysWithMarket,
    }
  )

  // Guardar en training_runs
  const trainingRunId = await saveTrainingRun(result)

  // Actualizar job como done
  if (config.jobId) {
    await supabase.from('backtest_jobs').update({
      status: 'done',
      finished_at: finishedAt,
      result: {
        hitRate: result.hitRate,
        totalDays: result.totalDays,
        resolvedDays: result.resolvedDays,
        wins: result.wins,
        daysWithMarket: result.daysWithMarket,
        totalProfit: result.totalProfit,
        passed: result.passed,
        rmseBySource: result.rmseBySource,
        durationSeconds: result.durationSeconds,
      },
      training_run_id: trainingRunId,
    }).eq('id', config.jobId)
  }

  return result
}

// ─── Guardar en Supabase ──────────────────────────────────────────────────────

async function saveTrainingRun(result: RealBacktestResult): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('training_runs').insert({
      days_tested: result.resolvedDays,
      hit_rate: result.hitRate,
      best_ensemble: result.config.activeSources.reduce((acc, slug) => {
        acc[slug] = 1 / result.config.activeSources.length
        return acc
      }, {} as Record<string, number>),
      config: {
        startDate: result.config.startDate,
        endDate: result.config.endDate,
        budget: result.config.budget,
        activeSources: result.config.activeSources,
        daysWithPolymarket: result.daysWithMarket,
        avgTokensPerDay: result.avgTokensPerDay,
        rmseBySource: result.rmseBySource,
        durationSeconds: result.durationSeconds,
      },
      notes: result.passed
        ? `✅ OBJ SUPERADO: ${(result.hitRate * 100).toFixed(1)}% — profit total: ${result.totalProfit > 0 ? '+' : ''}${result.totalProfit} USDC`
        : `❌ Hit rate ${(result.hitRate * 100).toFixed(1)}% < 90% — requiere ajuste de estrategia`,
    }).select('id').single()

    if (error) throw error
    return data.id
  } catch (err) {
    console.error('Error guardando training_run:', err)
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeWeightedAverage(
  temps: Record<string, number>,
  manager: WeatherSourceManager
): number {
  // Acceder a los pesos via método público o cálculo simple
  const values = Object.values(temps).filter(v => v !== undefined && !isNaN(v))
  if (values.length === 0) return 0

  // Usar el ensemble del manager si está disponible
  try {
    const ensemble = (manager as any).computeWeightedAverage(temps)
    if (ensemble && !isNaN(ensemble)) return ensemble
  } catch {}

  // Fallback: media simple
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ─── Entrypoint para ejecución directa ────────────────────────────────────────

if (require.main === module) {
  ;(async () => {
    const { setupManager } = await import('./setup')
    const manager = await setupManager()

    const endDate = format(subDays(new Date(), 1), 'yyyy-MM-dd')
    const startDate = format(subDays(new Date(), 90), 'yyyy-MM-dd')

    const result = await runRealBacktest(manager, {
      startDate,
      endDate,
      budget: 0.80,
      activeSources: manager.getRegisteredSources(),
    })

    console.log('\n═══════════════════════════════════════')
    console.log('RESULTADO FINAL DEL BACKTEST REAL')
    console.log(`Hit rate:      ${(result.hitRate * 100).toFixed(1)}%`)
    console.log(`Días totales:  ${result.totalDays}`)
    console.log(`Con mercado:   ${result.daysWithMarket}`)
    console.log(`Días resueltos: ${result.resolvedDays}`)
    console.log(`Profit total:  ${result.totalProfit > 0 ? '+' : ''}${result.totalProfit} USDC`)
    console.log(`Superó 90%:    ${result.passed ? '✅ SÍ' : '❌ NO'}`)
    console.log('═══════════════════════════════════════\n')
  })()
}
