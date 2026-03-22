// app/training/page.tsx
// Fase 1 — Backtest histórico, pesos del ensemble y simulación Polymarket en tiempo real.
// El panel PolymarketSimPanel se coloca tras el objetivo de la Fase 1 y antes del
// historial de runs: es el puente entre los datos de entrenamiento y los datos reales
// de mercado que el backtest usa como fuente de verdad.

import { getLatestTrainingRun, getWeatherSources } from '../../lib/supabase'
import { supabase } from '../../lib/supabase'
import { PolymarketSimPanel } from '../../components/PolymarketSimPanel'

export const revalidate = 300

export default async function TrainingPage() {
  const [latestRun, sources, allRuns] = await Promise.all([
    getLatestTrainingRun(),
    getWeatherSources(),
    supabase
      .from('training_runs')
      .select('*')
      .order('run_at', { ascending: false })
      .limit(10)
      .then(r => r.data),
  ])

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Entrenamiento</h1>
        <p className="text-gray-400 text-sm mt-1">
          Fase 1 — Backtest histórico y optimización del ensemble
        </p>
      </div>

      {/* ── Objetivo principal ──────────────────────────────────────────── */}
      <section className="bg-gray-900 border-2 border-dashed border-yellow-900 rounded-xl p-5">
        <h2 className="text-yellow-500 font-semibold text-sm mb-2">⭐ Objetivo de la Fase 1</h2>
        <p className="text-gray-300 text-sm leading-relaxed">
          Encontrar la combinación de{' '}
          <strong className="text-white">3 tokens de Polymarket</strong> cuya compra conjunta
          (coste total{' '}
          <strong className="text-white">&lt; 0.80 USDC</strong>) habría acertado en{' '}
          <strong className="text-green-400">≥ 90% de los días</strong> del último año.
        </p>
        <p className="text-gray-500 text-xs mt-2">
          Un día "acierta" cuando al menos uno de los tres tokens [pred-1°, pred°, pred+1°]
          resuelve en YES. La temperatura ganadora para cada día se extrae directamente de
          Polymarket — los paneles de abajo muestran el slug de mañana y los resultados
          reales de los últimos días.
        </p>
      </section>

      {/* ── Panel de simulación Polymarket (ventana apuestas + histórico) ── */}
      <PolymarketSimPanel />

      {/* ── Último run de backtest ──────────────────────────────────────── */}
      {latestRun && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-gray-300">Último backtest</h2>
            <span
              className={`text-xs px-2 py-1 rounded-full font-medium ${
                latestRun.passed
                  ? 'bg-green-950 text-green-400 border border-green-800'
                  : 'bg-red-950 text-red-400 border border-red-800'
              }`}
            >
              {latestRun.passed ? '✅ Objetivo superado' : '❌ Sin superar objetivo'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-xs text-gray-500">Hit rate</p>
              <p
                className={`text-2xl font-bold mt-0.5 ${
                  latestRun.hit_rate >= 0.9 ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {(latestRun.hit_rate * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-600 mt-0.5">objetivo ≥ 90%</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Días con mercado</p>
              <p className="text-2xl font-bold mt-0.5 text-white">{latestRun.days_tested}</p>
              <p className="text-xs text-gray-600 mt-0.5">días evaluados</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Ejecutado</p>
              <p className="text-sm font-medium mt-0.5 text-gray-300">
                {new Date(latestRun.run_at).toLocaleDateString('es-ES', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </div>
          </div>

          {latestRun.notes && (
            <p className="text-gray-500 text-xs border-t border-gray-800 pt-3">
              {latestRun.notes}
            </p>
          )}
        </section>
      )}

      {/* ── Pesos del ensemble ──────────────────────────────────────────── */}
      {sources && sources.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">
            Pesos del ensemble ({sources.filter(s => s.active).length} fuentes activas)
          </h2>
          <div className="space-y-2.5">
            {sources.map(src => (
              <div
                key={src.id}
                className={`flex items-center gap-3 ${src.active ? '' : 'opacity-40'}`}
              >
                <span className="text-sm text-gray-400 w-36 shrink-0 truncate" title={src.name}>
                  {src.name}
                </span>
                <div className="flex-1 bg-gray-800 rounded-full h-1.5 min-w-0">
                  <div
                    className="h-1.5 rounded-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${(src.weight * 100).toFixed(0)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400 w-10 text-right shrink-0">
                  {(src.weight * 100).toFixed(0)}%
                </span>
                {src.rmse_365d != null && (
                  <span className="text-xs text-gray-600 w-24 text-right shrink-0">
                    RMSE {src.rmse_365d.toFixed(2)}°C
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Historial de runs ───────────────────────────────────────────── */}
      {allRuns && allRuns.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">Historial de backtests</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 pr-4 font-normal">Fecha</th>
                <th className="text-right py-2 pr-4 font-normal">Días</th>
                <th className="text-right py-2 pr-4 font-normal">Hit rate</th>
                <th className="text-right py-2 font-normal">Estado</th>
              </tr>
            </thead>
            <tbody>
              {(allRuns as any[]).map(run => (
                <tr key={run.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                  <td className="py-2.5 pr-4 text-gray-300">
                    {new Date(run.run_at).toLocaleDateString('es-ES')}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-gray-400">{run.days_tested}</td>
                  <td className="py-2.5 pr-4 text-right font-medium">
                    <span className={run.hit_rate >= 0.9 ? 'text-green-400' : 'text-red-400'}>
                      {(run.hit_rate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="py-2.5 text-right">
                    {run.passed
                      ? <span className="text-green-500 text-xs">✅</span>
                      : <span className="text-red-500 text-xs">❌</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

    </div>
  )
}
