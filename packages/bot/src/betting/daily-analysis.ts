// packages/bot/src/betting/daily-analysis.ts
// ──────────────────────────────────────────────────────────────────────────────
// Análisis diario matutino — se ejecuta a las 08:00 Madrid.
//
// Flujo:
//   1. Leer sesgo N almacenado en bot_config (read-only)
//   2. Obtener predicción ensemble para MAÑANA con pesos actuales en BD
//   3. Aplicar corrección: temp_ajustada = ensemble + N
//   4. Proponer tokens:
//        Token 1 = ceil(temp_ajustada)
//        Token 2 = ceil(temp_ajustada) + 1
//   5. Loggear propuesta completa en bot_events
//
// NOTA: Ni los pesos ni el sesgo N se modifican aquí.
//       Ambos se gestionan exclusivamente desde el AI Optimizer del dashboard.
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { getCurrentBias } from './bias-optimizer'
import { BotEventLogger } from './logger'
import { GammaClient } from '../polymarket/gamma'

const logger = new BotEventLogger('ANALYSIS')

// ─── Runner principal ─────────────────────────────────────────────────────────

export async function runDailyAnalysis(): Promise<void> {
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

  await logger.log('info', 'prediction',
    `━━━━━━━━━━ Análisis diario — propuesta para ${tomorrow} ━━━━━━━━━━`
  )

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 1 — Leer sesgo N almacenado (read-only — lo gestiona el AI Optimizer)
  // ─────────────────────────────────────────────────────────────────────────
  const n     = await getCurrentBias()
  const nSign = n >= 0 ? '+' : ''
  await logger.info(`Sesgo N = ${nSign}${n.toFixed(3)}°C (valor gestionado por AI Optimizer)`)

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 2 — Ensemble forecast con pesos actuales de BD
  // ─────────────────────────────────────────────────────────────────────────
  await logger.info('Paso 2/2 — Calculando predicción ensemble para mañana…')

  // Cargar pesos actuales desde Supabase (gestionados por AI Optimizer)
  const { data: sourcesData } = await supabase
    .from('weather_sources')
    .select('slug, weight')
    .eq('active', true)

  const currentWeights: Record<string, number> = sourcesData
    ? Object.fromEntries(sourcesData.map(s => [s.slug, s.weight]))
    : {}

  await logger.info(
    'Pesos en uso',
    {
      pesos: Object.entries(currentWeights)
        .sort(([, a], [, b]) => b - a)
        .map(([s, w]) => `${s}: ${(w * 100).toFixed(1)}%`)
        .join(' | '),
    }
  )

  let ensembleRaw: number
  let sourceTemps: Record<string, number> = {}

  try {
    const manager  = await setupManager(currentWeights)
    const forecast = await manager.getEnsembleForecast(tomorrow)
    ensembleRaw    = forecast.ensembleTemp
    sourceTemps    = forecast.sourceTemps
  } catch (err) {
    await logger.error('Error obteniendo forecast del ensemble', err)
    return
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Aplicar corrección N y calcular tokens propuestos
  // ─────────────────────────────────────────────────────────────────────────
  const ensembleAdj = parseFloat((ensembleRaw + n).toFixed(4))
  const token1      = Math.ceil(ensembleAdj)    // ceil(ensemble + N)
  const token2      = token1 + 1                // ceil(ensemble + N) + 1

  // ─────────────────────────────────────────────────────────────────────────
  // Consultar precios actuales en Polymarket (opcional, no fatal)
  // ─────────────────────────────────────────────────────────────────────────
  let priceToken1: number | null = null
  let priceToken2: number | null = null

  try {
    const gamma     = new GammaClient()
    const dayTokens = await gamma.getTokensForDate(tomorrow)

    if (dayTokens.available) {
      const match1 = dayTokens.tokens.find(t => t.tempCelsius === token1)
      const match2 = dayTokens.tokens.find(t => t.tempCelsius === token2)
      priceToken1  = match1?.price ?? null
      priceToken2  = match2?.price ?? null
    }
  } catch {
    // Mercado puede no estar disponible aún — no es un error crítico
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Log propuesta completa
  // ─────────────────────────────────────────────────────────────────────────
  const p1Str = priceToken1 !== null ? ` @ ${(priceToken1 * 100).toFixed(1)}¢` : ' (precio no disp.)'
  const p2Str = priceToken2 !== null ? ` @ ${(priceToken2 * 100).toFixed(1)}¢` : ' (precio no disp.)'

  const biasLine = `N = ${nSign}${n.toFixed(3)}°C  (gestionado por AI Optimizer)`

  await logger.log(
    'success',
    'prediction',
    `📊 PROPUESTA ${tomorrow}\n` +
    `   Ensemble bruto:  ${ensembleRaw.toFixed(3)}°C\n` +
    `   ${biasLine}\n` +
    `   Ensemble ajust.: ${ensembleAdj.toFixed(3)}°C\n` +
    `   ─────────────────────────────────\n` +
    `   🎯 Token 1 → ${token1}°C${p1Str}\n` +
    `   🎯 Token 2 → ${token2}°C${p2Str}`,
    {
      date:        tomorrow,
      ensembleRaw: parseFloat(ensembleRaw.toFixed(4)),
      biasN:       n,
      ensembleAdj,
      token1,
      token2,
      priceToken1,
      priceToken2,
      sourceTemps,
      weightsUsed: currentWeights,
    }
  )

  console.log('\n')
  console.log(`📊 Análisis diario — ${tomorrow}`)
  console.log(`   Ensemble bruto   : ${ensembleRaw.toFixed(3)}°C`)
  console.log(`   Sesgo N          : ${nSign}${n.toFixed(3)}°C`)
  console.log(`   Ensemble ajustado: ${ensembleAdj.toFixed(3)}°C`)
  console.log(`   ──────────────────────────────────`)
  console.log(`   🎯 Token 1 → ${token1}°C${p1Str}`)
  console.log(`   🎯 Token 2 → ${token2}°C${p2Str}`)
  console.log('\n')
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────

if (require.main === module) {
  runDailyAnalysis().catch(err => {
    console.error('Fatal en runDailyAnalysis:', err)
    process.exit(1)
  })
}
