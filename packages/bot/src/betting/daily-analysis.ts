// packages/bot/src/betting/daily-analysis.ts
// ──────────────────────────────────────────────────────────────────────────────
// Análisis diario matutino — se ejecuta a las 08:00 Madrid.
//
// Flujo completo:
//   1. Reoptimizar pesos de fuentes (MAE inverso sobre últimos 30 días)
//   2. Calcular sesgo N = mean(actual - ensemble) sobre histórico
//   3. Obtener predicción ensemble para MAÑANA con pesos recién optimizados
//   4. Aplicar corrección: temp_ajustada = ensemble + N
//   5. Proponer tokens:
//        Token 1 = ceil(temp_ajustada)
//        Token 2 = ceil(temp_ajustada) + 1
//   6. Loggear propuesta completa en bot_events
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { optimizeSourceWeights } from './weight-optimizer'
import { optimizeBias, getCurrentBias } from './bias-optimizer'
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
  // PASO 1 — Reoptimizar pesos de fuentes
  // ─────────────────────────────────────────────────────────────────────────
  await logger.info('Paso 1/3 — Optimizando pesos de fuentes…')

  try {
    await optimizeSourceWeights()
  } catch (err) {
    await logger.error('Error en optimización de pesos', err)
    // No es fatal: continuamos con los pesos actuales en BD
  }

  // Cargar pesos recién guardados
  const { data: sourcesData } = await supabase
    .from('weather_sources')
    .select('slug, weight')
    .eq('active', true)

  const freshWeights: Record<string, number> = sourcesData
    ? Object.fromEntries(sourcesData.map(s => [s.slug, s.weight]))
    : {}

  await logger.info(
    'Pesos actualizados',
    {
      pesos: Object.entries(freshWeights)
        .sort(([, a], [, b]) => b - a)
        .map(([s, w]) => `${s}: ${(w * 100).toFixed(1)}%`)
        .join(' | '),
    }
  )

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 2 — Calcular sesgo N
  // ─────────────────────────────────────────────────────────────────────────
  await logger.info('Paso 2/3 — Calculando sesgo N del ensemble…')

  let n = 0
  let biasInfo: { prevN: number; delta: number; daysUsed: number; mae: number } | null = null

  try {
    const result = await optimizeBias()
    if (result) {
      n         = result.n
      biasInfo  = result
    } else {
      // Si no hay suficientes datos, usar N almacenado previamente
      n = await getCurrentBias()
      await logger.warn(`Sin datos suficientes para recalcular N — usando N almacenado: ${n >= 0 ? '+' : ''}${n.toFixed(3)}°C`)
    }
  } catch (err) {
    await logger.error('Error calculando sesgo N', err)
    n = await getCurrentBias()
  }

  const nSign = n >= 0 ? '+' : ''
  await logger.info(`Sesgo N = ${nSign}${n.toFixed(3)}°C`, biasInfo ? {
    prevN:    biasInfo.prevN,
    delta:    biasInfo.delta,
    daysUsed: biasInfo.daysUsed,
    mae:      biasInfo.mae,
  } : {})

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 3 — Ensemble forecast con pesos frescos
  // ─────────────────────────────────────────────────────────────────────────
  await logger.info('Paso 3/3 — Calculando predicción ensemble para mañana…')

  let ensembleRaw: number
  let sourceTemps: Record<string, number> = {}

  try {
    const manager = await setupManager(freshWeights)
    const forecast = await manager.getEnsembleForecast(tomorrow)
    ensembleRaw    = forecast.ensembleTemp
    sourceTemps    = forecast.sourceTemps
  } catch (err) {
    await logger.error('Error obteniendo forecast del ensemble', err)
    return
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 4 — Aplicar corrección N
  // ─────────────────────────────────────────────────────────────────────────
  const ensembleAdj = parseFloat((ensembleRaw + n).toFixed(4))
  const token1      = Math.ceil(ensembleAdj)          // ceil(pred + N)
  const token2      = token1 + 1                      // ceil(pred + N) + 1

  // ─────────────────────────────────────────────────────────────────────────
  // PASO 5 — Consultar precios actuales en Polymarket (opcional, no fatal)
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
  // PASO 6 — Log propuesta completa
  // ─────────────────────────────────────────────────────────────────────────
  const p1Str = priceToken1 !== null ? ` @ ${(priceToken1 * 100).toFixed(1)}¢` : ' (precio no disp.)'
  const p2Str = priceToken2 !== null ? ` @ ${(priceToken2 * 100).toFixed(1)}¢` : ' (precio no disp.)'

  const sourceSummary = Object.entries(sourceTemps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, t]) => `${s}: ${t.toFixed(1)}°C`)
    .join(' | ')

  const biasLine = biasInfo
    ? `N = ${nSign}${n.toFixed(3)}°C  (Δ ${biasInfo.delta >= 0 ? '+' : ''}${biasInfo.delta.toFixed(3)}°C vs ciclo anterior, MAE post-corrección: ${biasInfo.mae.toFixed(3)}°C)`
    : `N = ${nSign}${n.toFixed(3)}°C  (valor almacenado)`

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
      date:          tomorrow,
      ensembleRaw:   parseFloat(ensembleRaw.toFixed(4)),
      biasN:         n,
      biasNPrev:     biasInfo?.prevN ?? null,
      biasDelta:     biasInfo?.delta ?? null,
      ensembleAdj:   ensembleAdj,
      token1,
      token2,
      priceToken1,
      priceToken2,
      sourceTemps,
      weightsUsed:   freshWeights,
      mae:           biasInfo?.mae ?? null,
      daysUsed:      biasInfo?.daysUsed ?? null,
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
  if (biasInfo) {
    const deltaSign = biasInfo.delta >= 0 ? '+' : ''
    console.log(`   ──────────────────────────────────`)
    console.log(`   N anterior : ${biasInfo.prevN >= 0 ? '+' : ''}${biasInfo.prevN.toFixed(3)}°C`)
    console.log(`   Δ N        : ${deltaSign}${biasInfo.delta.toFixed(3)}°C`)
    console.log(`   MAE post-N : ${biasInfo.mae.toFixed(3)}°C  (${biasInfo.daysUsed} días)`)
  }
  console.log('\n')
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────

if (require.main === module) {
  runDailyAnalysis().catch(err => {
    console.error('Fatal en runDailyAnalysis:', err)
    process.exit(1)
  })
}
