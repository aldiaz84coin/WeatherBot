// app/page.tsx
// Overview principal: estado del bot, KPIs y últimas predicciones

import { getPerformance, getDailySummaries, getLatestTrainingRun } from '../lib/supabase'
import { BotStatus } from '../components/BotStatus'
import { PredictionCard } from '../components/PredictionCard'
import { PnlChart } from '../components/PnlChart'
import { TrainingResults } from '../components/TrainingResults'

export const revalidate = 60 // revalidar cada 60s

export default async function HomePage() {
  const [perf, summaries, latestRun] = await Promise.all([
    getPerformance(),
    getDailySummaries(60),
    getLatestTrainingRun(),
  ])

  const isLive = process.env.NEXT_PUBLIC_LIVE_TRADING === 'true'

  return (
    <div className="space-y-8">

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

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <PredictionCard
          label="Hit Rate"
          value={perf ? `${perf.hit_rate_pct}%` : '—'}
          sublabel="objetivo ≥ 90%"
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

      {/* Fase 1: estado del entrenamiento */}
      {latestRun && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-300">
              ⭐ Fase 1 — Último entrenamiento
            </h2>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              latestRun.passed
                ? 'bg-green-950 text-green-400 border border-green-800'
                : 'bg-yellow-950 text-yellow-400 border border-yellow-800'
            }`}>
              {latestRun.passed ? '✅ Superado' : '⏳ En progreso'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-gray-500 text-xs">Hit rate conseguido</p>
              <p className="text-white font-medium mt-0.5">
                {(latestRun.hit_rate * 100).toFixed(1)}%
                <span className="text-gray-500 text-xs ml-1">/ objetivo 90%</span>
              </p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">Días de backtest</p>
              <p className="text-white font-medium mt-0.5">{latestRun.days_tested}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">Ejecutado</p>
              <p className="text-white font-medium mt-0.5">
                {new Date(latestRun.run_at).toLocaleDateString('es-ES')}
              </p>
            </div>
          </div>
          {latestRun.notes && (
            <p className="text-gray-500 text-xs mt-3 border-t border-gray-800 pt-3">
              {latestRun.notes}
            </p>
          )}
        </section>
      )}

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
