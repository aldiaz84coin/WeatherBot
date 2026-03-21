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
  token_low: number
  token_mid: number
  token_high: number
  total_cost_usdc: number
  simulated: boolean
  actual_temp: number | null
  won: boolean | null
  winning_position: string | null
  pnl_net_usdc: number | null
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getPerformance() {
  const { data } = await supabase.from('v_performance').select('*').single()
  return data
}

export async function getDailySummaries(limit = 30) {
  const { data } = await supabase
    .from('v_daily_summary')
    .select('*')
    .limit(limit)
  return data as DailySummary[] | null
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
