// packages/dashboard/app/predictions/page.tsx

import { createClient }      from '@supabase/supabase-js'
import { getDailySummaries } from '../../lib/supabase'
import { TrainingResults }   from '../../components/TrainingResults'
import { WeightsBiasPanel }  from '../../components/WeightsBiasPanel'

export const revalidate = 60

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// FIX: leer bias directamente de bot_config (igual que page.tsx),
// no de bot_events que usa campos que no existen (category, metadata, created_at).
async function getWeightsAndBias() {
  const supabase = getSupabase()

  const [{ data: sources }, { data: biasConfig }] = await Promise.all([
    supabase
      .from('weather_sources')
      .select('slug, name, weight, updated_at')
      .eq('active', true)
      .order('weight', { ascending: false }),
    supabase
      .from('bot_config')
      .select('value, updated_at')
      .eq('key', 'prediction_bias_n')
      .maybeSingle(),
  ])

  const rawBias = biasConfig?.value
  const biasN   = rawBias !== null && rawBias !== undefined ? Number(rawBias) : null

  return {
    weights:   sources ?? [],
    biasN:     biasN !== null && !isNaN(biasN) ? biasN : null,
    updatedAt: biasConfig?.updated_at ?? null,
  }
}

export default async function PredictionsPage() {
  const [summaries, { weights, biasN, updatedAt }] = await Promise.all([
    getDailySummaries(365),
    getWeightsAndBias(),
  ])

  const resolved = summaries?.filter(s => s.actual_temp !== null) ?? []
  const pending  = summaries?.filter(s => s.actual_temp === null) ?? []
  const winRate  = resolved.length
    ? ((resolved.filter(s => s.won).length / resolved.length) * 100).toFixed(1)
    : null

  return (
    <div className="space-y-6">

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Predicciones</h1>
          <p className="text-gray-400 text-sm mt-1">
            Historial completo · {summaries?.length ?? 0} entradas
          </p>
        </div>
        <div className="text-right">
          {winRate && <p className="text-lg font-semibold text-white">{winRate}%</p>}
          <p className="text-xs text-gray-500">hit rate histórico</p>
        </div>
      </div>

      <WeightsBiasPanel weights={weights} biasN={biasN} updatedAt={updatedAt} />

      {pending.length > 0 && (
        <section className="bg-gray-900 border border-yellow-900/50 rounded-xl p-4">
          <p className="text-xs text-yellow-600 font-medium mb-3">
            ⏳ Pendientes de resolver ({pending.length})
          </p>
          <TrainingResults summaries={pending} />
        </section>
      )}

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-300 mb-4">
          Resueltas ({resolved.length})
        </h2>
        <TrainingResults summaries={resolved} />
      </section>

    </div>
  )
}
