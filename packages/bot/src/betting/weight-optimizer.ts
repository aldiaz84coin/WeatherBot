// packages/bot/src/betting/weight-optimizer.ts
// ──────────────────────────────────────────────────────────────────────────────
// Algoritmo de optimización de pesos del ensemble.
// Se ejecuta automáticamente después de cada liquidación.
//
// Algoritmo:
//   1. Obtener los últimos N días con temperatura real registrada
//   2. Para cada fuente, calcular el MAE (error absoluto medio) contra la real
//   3. Peso = 1/MAE (inversamente proporcional al error), normalizado a suma=1
//   4. Guardar nuevos pesos en weather_sources
//   5. Registrar training_run con los nuevos pesos
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from '../db/supabase'
import { BotEventLogger } from './logger'

const logger = new BotEventLogger('WEIGHTS')

const MIN_DAYS_FOR_OPTIMIZATION = 5   // mínimo de días con resultado para optimizar
const LOOKBACK_DAYS             = 30  // cuántos días usar para el cálculo

// ─── Optimizador ─────────────────────────────────────────────────────────────

export async function optimizeSourceWeights(cycleId?: string | null): Promise<void> {
  await logger.info('Iniciando optimización de pesos de fuentes…', {}, cycleId ?? undefined)

  // ── 1. Predicciones recientes con temperatura real ────────────────────────
  const { data: preds, error } = await supabase
    .from('predictions')
    .select(`
      target_date,
      source_temps,
      results ( actual_temp )
    `)
    .not('source_temps', 'is', null)
    .order('target_date', { ascending: false })
    .limit(LOOKBACK_DAYS)

  if (error) {
    await logger.error(`Error cargando predicciones: ${error.message}`, error, cycleId ?? undefined)
    return
  }

  if (!preds || preds.length === 0) {
    await logger.warn('Sin predicciones con source_temps — saltando optimización')
    return
  }

  // ── 2. Calcular MAE por fuente ────────────────────────────────────────────
  const sourceErrors: Record<string, number[]> = {}

  for (const pred of preds) {
    // results puede ser array (join) o null
    const resultRows = Array.isArray(pred.results) ? pred.results : pred.results ? [pred.results] : []
    const actualTemp: number | null = resultRows[0]?.actual_temp ?? null

    if (actualTemp === null || actualTemp === undefined) continue
    if (!pred.source_temps || typeof pred.source_temps !== 'object') continue

    for (const [source, temp] of Object.entries(pred.source_temps as Record<string, number>)) {
      if (typeof temp !== 'number' || isNaN(temp)) continue
      if (!sourceErrors[source]) sourceErrors[source] = []
      sourceErrors[source].push(Math.abs(temp - actualTemp))
    }
  }

  // ── 3. Filtrar fuentes con datos suficientes ──────────────────────────────
  const validSources = Object.entries(sourceErrors)
    .filter(([, errors]) => errors.length >= MIN_DAYS_FOR_OPTIMIZATION)

  if (validSources.length === 0) {
    await logger.warn(
      `Solo hay datos en < ${MIN_DAYS_FOR_OPTIMIZATION} días por fuente — sin optimización`,
      { diasConDatos: Object.keys(sourceErrors).length },
      cycleId ?? undefined
    )
    return
  }

  // ── 4. Calcular MAE y pesos (1/MAE normalizado) ───────────────────────────
  const maes: Record<string, number>    = {}
  const weights: Record<string, number> = {}

  for (const [source, errors] of validSources) {
    maes[source] = parseFloat(
      (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(4)
    )
  }

  // Inverso del MAE → mayor precisión = mayor peso
  const inverses: Record<string, number> = {}
  for (const [source, mae] of Object.entries(maes)) {
    inverses[source] = mae > 0 ? 1 / mae : 10  // si MAE=0 exacto, peso máximo
  }

  const totalInverse = Object.values(inverses).reduce((a, b) => a + b, 0)
  for (const [source, inv] of Object.entries(inverses)) {
    weights[source] = parseFloat((inv / totalInverse).toFixed(6))
  }

  // ── 5. Actualizar weather_sources ─────────────────────────────────────────
  let updatedCount = 0
  for (const [slug, weight] of Object.entries(weights)) {
    const { error: updateErr } = await supabase
      .from('weather_sources')
      .update({ weight, updated_at: new Date().toISOString() })
      .eq('slug', slug)

    if (!updateErr) updatedCount++
  }

  // ── 6. Registrar training_run ─────────────────────────────────────────────
  // Calculamos una hit_rate simbólica con los últimos datos disponibles
  const { data: recentResults } = await supabase
    .from('results')
    .select('won')
    .order('target_date', { ascending: false })
    .limit(30)

  const totalR   = recentResults?.length ?? 0
  const winsR    = recentResults?.filter(r => r.won).length ?? 0
  const hitRate  = totalR > 0 ? winsR / totalR : 0
  const passed   = hitRate >= 0.9

  await supabase.from('training_runs').insert({
    run_at:       new Date().toISOString(),
    days_tested:  validSources[0]?.[1]?.length ?? 0,
    hit_rate:     parseFloat(hitRate.toFixed(4)),
    best_ensemble: weights,
    passed,
    notes:        `Auto-optimización post-settlement — MAE inverso sobre ${LOOKBACK_DAYS}d`,
  })

  // ── 7. Log ────────────────────────────────────────────────────────────────
  const weightSummary = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .map(([s, w]) => `${s}: ${(w * 100).toFixed(1)}%`)
    .join(' | ')

  const maeSummary = Object.entries(maes)
    .sort(([, a], [, b]) => a - b)
    .map(([s, m]) => `${s}: ${m}°C`)
    .join(' | ')

  await logger.log('success', 'weight_update',
    `Pesos actualizados (${updatedCount} fuentes) — hit_rate últimos ${LOOKBACK_DAYS}d: ${(hitRate * 100).toFixed(1)}%`,
    {
      weights: weightSummary,
      maes:    maeSummary,
      daysUsed: validSources.length,
      hitRate,
      passed,
    },
    cycleId ?? undefined
  )
}
