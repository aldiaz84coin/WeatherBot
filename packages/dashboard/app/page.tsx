// packages/dashboard/app/page.tsx
// Overview principal: estado del bot, KPIs, configuración activa y últimas predicciones

import { createClient } from '@supabase/supabase-js'
import { getPerformance, getDailySummaries, getLatestTrainingRun } from '../lib/supabase'
import { BotStatus }        from '../components/BotStatus'
import { PredictionCard }   from '../components/PredictionCard'
import { PnlChart }         from '../components/PnlChart'
import { TrainingResults }  from '../components/TrainingResults'
import { WeightsBiasPanel } from '../components/WeightsBiasPanel'

export const revalidate = 60

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

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
  const biasN = rawBias !== null && rawBias !== undefined ? Number(rawBias) : null

  return {
    weights:   sources ?? [],
    biasN:     biasN !== null && !isNaN(biasN) ? biasN : null,
    updatedAt: biasConfig?.updated_at ?? null,
  }
}

async function getBettingMode(): Promise<boolean> {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', 'betting_mode')
    .maybeSingle()

  // value es jsonb: puede llegar como string "live" o '"live"'
  const raw = data?.value
  const mode = typeof raw === 'string' ? raw.replace(/"/g, '') : String(raw ?? '')
  return mode === 'live'
}

export default async function HomePage() {
  const [perf, summaries, latestRun, { weights, biasN, updatedAt }, isLive] = await Promise.all([
    getPerformance(),
    getDailySummaries(60),
    getLatestTrainingRun(),
    getWeightsAndBias(),
    getBettingMode(),
  ])

  return (
    <div className="space-y-6">

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Overview</h1>
          <p className="text-gray-400 text-sm mt-1">
            Predicción de temperatura máxima en Madrid · Polymarket
          </p>
        </div>
        <BotStatus isLive={isLive} latestRun={latestRun} />
      </div>

      <WeightsBiasPanel weights={weights} biasN={biasN} updatedAt={updatedAt} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <PredictionCard
          label="Hit Rate"
          value={perf ? `${perf.hit_rate_pct}%` : '—'}
          sublabel="operaciones resueltas"
          highlight={perf ? parseFloat(perf.hit_rate_pct) >= 90 : false}
        />
        <PredictionCard
          label="Operaciones"
          value={perf ? String(perf.total) : '—'}
          sublabel={`${perf?.wins ?? 0}W / ${perf?.losses ?? 0}L`}
        />
        <PredictionCard
          label="P&L Acumulado"
          value={perf ? `${Number(perf.cumulative_pnl) >= 0 ? '+' : ''}${perf.cumulative_pnl} USDC` : '—'}
          sublabel="neto tras costes"
          positive={perf ? Number(perf.cumulative_pnl) >= 0 : undefined}
        />
        <PredictionCard
          label="P&L Medio/Día"
          value={perf ? `${Number(perf.avg_daily_pnl) >= 0 ? '+' : ''}${perf.avg_daily_pnl} USDC` : '—'}
          sublabel="promedio diario"
          positive={perf ? Number(perf.avg_daily_pnl) >= 0 : undefined}
        />
      </div>

      {summaries && summaries.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">P&L acumulado</h2>
          <PnlChart summaries={summaries} />
        </section>
      )}

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Últimas predicciones</h2>
          <a href="/predictions" className="text-xs text-blue-400 hover:text-blue-300">Ver todas →</a>
        </div>
        <TrainingResults summaries={summaries?.slice(0, 10) ?? []} />
      </section>

    </div>
  )
}
