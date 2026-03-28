// packages/bot/src/betting/bias-optimizer.ts
// ──────────────────────────────────────────────────────────────────────────────
// Calcula el sesgo sistemático N de las predicciones del ensemble.
//
// Definición:
//   temp_real = ensemble_pred + N  →  N = mean(actual - ensemble) sobre histórico
//
// Si N > 0 el ensemble tiende a predecir por debajo de la real.
// Si N < 0 el ensemble tiende a predecir por encima.
//
// El valor se almacena en bot_config[prediction_bias_n] y se aplica en el
// motor de apuestas y en el análisis diario antes de seleccionar los tokens.
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from '../db/supabase'
import { BotEventLogger } from './logger'

const logger = new BotEventLogger('BIAS')

const LOOKBACK_DAYS      = 30   // ventana de cálculo
const MIN_DAYS_FOR_BIAS  = 5    // mínimo de días para confiar en N
const CONFIG_KEY_N       = 'prediction_bias_n'
const CONFIG_KEY_PREV_N  = 'prediction_bias_prev_n'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface BiasResult {
  n:          number   // sesgo calculado (°C)
  prevN:      number   // sesgo del ciclo anterior
  delta:      number   // n - prevN
  daysUsed:   number   // observaciones usadas
  rmse:       number   // RMSE residual después de corregir con N
  mae:        number   // MAE residual después de corregir con N
}

// ─── Lectura del N actual ─────────────────────────────────────────────────────

export async function getCurrentBias(): Promise<number> {
  const { data } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', CONFIG_KEY_N)
    .maybeSingle()

  if (!data) return 0
  const val = typeof data.value === 'number' ? data.value : Number(data.value)
  return isNaN(val) ? 0 : val
}

// ─── Optimizador ─────────────────────────────────────────────────────────────

export async function optimizeBias(cycleId?: string): Promise<BiasResult | null> {
  await logger.info('Calculando sesgo N del ensemble…', {}, cycleId)

  // ── 1. Cargar histórico: predicciones con resultado real ──────────────────
  const { data: rows, error } = await supabase
    .from('predictions')
    .select(`
      target_date,
      ensemble_temp,
      results ( actual_temp )
    `)
    .not('ensemble_temp', 'is', null)
    .order('target_date', { ascending: false })
    .limit(LOOKBACK_DAYS)

  if (error) {
    await logger.error(`Error cargando predicciones para sesgo: ${error.message}`, error, cycleId)
    return null
  }

  // ── 2. Filtrar filas con temperatura real disponible ─────────────────────
  const pairs: Array<{ pred: number; actual: number; date: string }> = []

  for (const row of rows ?? []) {
    const resultRows = Array.isArray(row.results) ? row.results : row.results ? [row.results] : []
    const actual: number | null = resultRows[0]?.actual_temp ?? null
    if (actual === null || row.ensemble_temp === null) continue
    pairs.push({
      pred:   row.ensemble_temp,
      actual,
      date:   row.target_date,
    })
  }

  if (pairs.length < MIN_DAYS_FOR_BIAS) {
    await logger.warn(
      `Solo ${pairs.length} días con resultado real — mínimo ${MIN_DAYS_FOR_BIAS} para calcular N`,
      { daysAvailable: pairs.length },
      cycleId
    )
    return null
  }

  // ── 3. N = mean(actual - pred) ────────────────────────────────────────────
  const residuals = pairs.map(p => p.actual - p.pred)
  const n         = parseFloat((residuals.reduce((a, b) => a + b, 0) / residuals.length).toFixed(4))

  // ── 4. RMSE y MAE post-corrección ─────────────────────────────────────────
  const correctedErrors = pairs.map(p => p.actual - (p.pred + n))
  const mae  = parseFloat((correctedErrors.map(Math.abs).reduce((a, b) => a + b, 0) / correctedErrors.length).toFixed(4))
  const rmse = parseFloat(Math.sqrt(correctedErrors.map(e => e * e).reduce((a, b) => a + b, 0) / correctedErrors.length).toFixed(4))

  // ── 5. Leer N previo para calcular delta ──────────────────────────────────
  const prevN = await getCurrentBias()
  const delta = parseFloat((n - prevN).toFixed(4))

  // ── 6. Guardar N en bot_config ────────────────────────────────────────────
  const now = new Date().toISOString()

  await supabase
    .from('bot_config')
    .upsert(
      { key: CONFIG_KEY_PREV_N, value: prevN,       description: 'Sesgo N del ciclo anterior',  updated_at: now },
      { onConflict: 'key' }
    )

  await supabase
    .from('bot_config')
    .upsert(
      { key: CONFIG_KEY_N,      value: n,            description: 'Sesgo medio ensemble (°C) — se suma al ensemble antes de ceil()',  updated_at: now },
      { onConflict: 'key' }
    )

  // ── 7. Log ────────────────────────────────────────────────────────────────
  const sign   = delta >= 0 ? '+' : ''
  const nSign  = n >= 0     ? '+' : ''

  await logger.log(
    'success',
    'bias_update',
    `Sesgo N = ${nSign}${n.toFixed(3)}°C  (delta vs ciclo anterior: ${sign}${delta.toFixed(3)}°C) — ` +
    `MAE post-corrección: ${mae.toFixed(3)}°C sobre ${pairs.length} días`,
    {
      n,
      prevN,
      delta,
      mae,
      rmse,
      daysUsed:  pairs.length,
      window:    LOOKBACK_DAYS,
    },
    cycleId
  )

  return { n, prevN, delta, daysUsed: pairs.length, rmse, mae }
}
