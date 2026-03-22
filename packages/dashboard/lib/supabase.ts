// lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

// El dashboard usa la clave anon (solo lectura) — nunca exponer la service key
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ─── Tipos de las tablas ────────────────────────────────────────────────────

export interface Prediction {
  id: string
  target_date: string
  predicted_at: string
  ensemble_temp: number
  source_temps: Record<string, number>
  token_low: number
  token_mid: number
  token_high: number
  total_cost_usdc: number
  simulated: boolean
}

export interface Result {
  id: string
  prediction_id: string
  target_date: string
  actual_temp: number
  won: boolean
  winning_position: 'low' | 'mid' | 'high' | null
  pnl_net_usdc: number
}

export interface TrainingRun {
  id: string
  run_at: string
  days_tested: number
  hit_rate: number
  passed: boolean
  best_ensemble: Record<string, number>
  notes: string
}

export interface DailySummary {
  target_date: string
  ensemble_temp: number

  // ── Modelo legacy (3 tokens) ───────────────────────────────────────────
  token_low:       number | null
  token_mid:       number | null
  token_high:      number | null
  total_cost_usdc: number | null

  // ── Modelo nuevo (2 tokens) ────────────────────────────────────────────
  token_a:      number | null
  token_b:      number | null
  cost_a_usdc:  number | null
  cost_b_usdc:  number | null
  stake_usdc:   number | null

  simulated:        boolean

  // ── Resultado (null si aún no resuelto) ────────────────────────────────
  actual_temp:      number | null
  won:              boolean | null
  winning_position: string | null
  pnl_net_usdc:     number | null
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getPerformance() {
  const { data } = await supabase.from('v_performance').select('*').single()
  return data
}

/**
 * Obtiene el resumen diario de predicciones consultando `predictions`
 * directamente (con join a `results`) para soportar tanto el modelo
 * legacy (token_low/mid/high) como el nuevo modelo de 2 tokens
 * (token_a / token_b).
 *
 * Ya NO depende de la vista `v_daily_summary`, que solo exponía columnas
 * legacy y dejaba en blanco los tokens/costes en predicciones nuevas.
 */
export async function getDailySummaries(limit = 30): Promise<DailySummary[] | null> {
  const { data, error } = await supabase
    .from('predictions')
    .select(`
      target_date,
      ensemble_temp,
      token_low,
      token_mid,
      token_high,
      token_a,
      token_b,
      cost_a_usdc,
      cost_b_usdc,
      stake_usdc,
      simulated,
      results (
        actual_temp,
        won,
        winning_position,
        pnl_net_usdc
      )
    `)
    .order('target_date', { ascending: false })
    .limit(limit)

  if (error || !data) return null

  return data.map((row: any) => {
    // `results` es un array (relación 1-N); tomamos el primer resultado si existe
    const result = Array.isArray(row.results) ? row.results[0] ?? null : row.results ?? null

    // total_cost_usdc: suma de los costes según el modelo disponible
    const total_cost_usdc =
      row.cost_a_usdc != null && row.cost_b_usdc != null
        ? row.cost_a_usdc + row.cost_b_usdc
        : null

    return {
      target_date:      row.target_date,
      ensemble_temp:    row.ensemble_temp,

      // Legacy
      token_low:        row.token_low  ?? null,
      token_mid:        row.token_mid  ?? null,
      token_high:       row.token_high ?? null,
      total_cost_usdc,

      // Nuevo modelo 2-token
      token_a:     row.token_a    ?? null,
      token_b:     row.token_b    ?? null,
      cost_a_usdc: row.cost_a_usdc ?? null,
      cost_b_usdc: row.cost_b_usdc ?? null,
      stake_usdc:  row.stake_usdc  ?? null,

      simulated:        row.simulated ?? false,

      // Resultado
      actual_temp:      result?.actual_temp      ?? null,
      won:              result?.won              ?? null,
      winning_position: result?.winning_position ?? null,
      pnl_net_usdc:     result?.pnl_net_usdc     ?? null,
    } satisfies DailySummary
  })
}

export async function getLatestTrainingRun() {
  const { data } = await supabase
    .from('training_runs')
    .select('*')
    .order('run_at', { ascending: false })
    .limit(1)
    .single()
  return data as TrainingRun | null
}

export async function getWeatherSources() {
  const { data } = await supabase
    .from('weather_sources')
    .select('*')
    .eq('active', true)
    .order('rmse_365d', { ascending: true })
  return data
}
