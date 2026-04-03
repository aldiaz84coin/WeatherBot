// packages/dashboard/app/page.tsx
// Overview principal: estado del bot, KPIs, configuración activa y últimas predicciones

import { createClient } from '@supabase/supabase-js'
import { getPerformance, getDailySummaries } from '../lib/supabase'
import { BotStatus }       from '../components/BotStatus'
import { PredictionCard }  from '../components/PredictionCard'
import { PnlChart }        from '../components/PnlChart'
import { TrainingResults } from '../components/TrainingResults'
import { WeightsBiasPanel } from '../components/WeightsBiasPanel'

export const revalidate = 60

// ── Helpers de datos ──────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

async function getWeightsAndBias() {
  const supabase = getSupabase()

  const [{ data: sources }, { data: lastEvent }] = await Promise.all([
    supabase
      .from('weather_sources')
      .select('slug, name, weight, updated_at')
      .eq('active', true)
      .order('weight', { ascending: false }),
    supabase
      .from('bot_events')
      .select('metadata, created_at')
      .eq('category', 'weight_update')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const meta    = lastEvent?.metadata as Record<string, unknown> | null
  const biasN   = (meta?.biasN   as number | undefined) ?? null
  const updated = lastEvent?.created_at ?? null

  return {
    weights:   sources ?? [],
    biasN,
    updatedAt: updated,
  }
}

async function getLatestTrainingRun() {
  const supabase = getSupabase()
  const { data } = await supabase
    .from('training_runs')
    .select('run_at, hit_rate, days_tested, passed, notes')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

// ── Página ────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const [perf, summaries, latestRun, { weights, biasN, updatedAt }] = await Promise.all([
    getPerformance(),
    getDailySummaries(60),
    getLatestTrainingRun(),
    getWeightsAndBias(),
  ])

  const isLive = process.env.NEXT_PUBLIC_LIVE_TRADING === 'true'

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Overview</h1>
          <p className="text-gray-400 text-sm mt-1">
            Predicción de temperatura máxima en Madrid · Polymarket
          </p>
        </div>
        <BotStatus isLive={isLive} latestRun={latestRun} />
      </div>

      {/* Configuración activa del bot */}
      <WeightsBiasPanel
        weights={weights}
        biasN={biasN}
        updatedAt={updatedAt}
      />

      {/* KPIs */}
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

      {/* Gráfico P&L */}
      {summaries && summaries.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">P&L acumulado</h2>
          <PnlChart summaries={summaries} />
        </section>
      )}

      {/* Tabla de predicciones recientes */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Últimas predicciones</h2>
          <a href="/predictions" className="text-xs text-blue-400 hover:text-blue-300">
            Ver todas →
          </a>
        </div>
        <TrainingResults summaries={summaries?.slice(0, 10) ?? []} />
      </section>

    </div>
  )
}
