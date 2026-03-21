// app/training/page.tsx
import { getLatestTrainingRun, getWeatherSources } from '../../lib/supabase'
import { supabase } from '../../lib/supabase'

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
      <div>
        <h1 className="text-2xl font-semibold text-white">Entrenamiento</h1>
        <p className="text-gray-400 text-sm mt-1">
          Fase 1 — Backtest histórico y optimización del ensemble
        </p>
      </div>

      {/* Objetivo principal */}
      <section className="bg-gray-900 border-2 border-dashed border-yellow-900 rounded-xl p-5">
        <h2 className="text-yellow-500 font-semibold text-sm mb-2">⭐ Objetivo de la Fase 1</h2>
        <p className="text-gray-300 text-sm leading-relaxed">
          Encontrar la combinación de <strong className="text-white">3 tokens de Polymarket</strong> cuya
          compra conjunta (coste total&nbsp;
          <strong className="text-white">&lt; 0.80 USDC</strong>) habría acertado en&nbsp;
          <strong className="text-green-400">≥ 90% de los días</strong> del último año.
        </p>
        <p className="text-gray-500 text-xs mt-2">
          Un día "acierta" cuando al menos uno de los tres tokens
          [pred-1°, pred°, pred+1°] resuelve en YES.
        </p>
      </section>

      {/* Último run */}
      {latestRun && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-gray-300">Último backtest</h2>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${
              latestRun.passed
                ? 'bg-green-950 text-green-400 border border-green-800'
                : 'bg-red-950 text-red-400 border border-red-800'
            }`}>
              {latestRun.passed ? '✅ Objetivo superado' : '❌ Sin superar objetivo'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-xs text-gray-500">Hit rate</p>
              <p className={`text-2xl font-bold mt-0.5 ${latestRun.hit_rate >= 0.9 ? 'text-green-400' : 'text-red-400'}`}>
                {(latestRun.hit_rate * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-600">objetivo ≥ 90%</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Días evaluados</p>
              <p className="text-2xl font-bold text-white mt-0.5">{latestRun.days_tested}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Fecha</p>
              <p className="text-white font-medium mt-0.5">
                {new Date(latestRun.run_at).toLocaleDateString('es-ES', {
                  day: 'numeric', month: 'long', year: 'numeric'
                })}
              </p>
            </div>
          </div>

          {/* Barra de progreso hacia el objetivo */}
          <div className="mt-3">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>0%</span>
              <span className="text-yellow-600">objetivo 90%</span>
              <span>100%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  latestRun.hit_rate >= 0.9 ? 'bg-green-500' : 'bg-yellow-500'
                }`}
                style={{ width: `${Math.min(latestRun.hit_rate * 100, 100)}%` }}
              />
              {/* Marcador del objetivo */}
              <div className="relative">
                <div className="absolute top-[-10px] left-[90%] w-px h-4 bg-yellow-600 opacity-60" />
              </div>
            </div>
          </div>

          {latestRun.notes && (
            <p className="text-gray-500 text-xs mt-4 pt-3 border-t border-gray-800">
              {latestRun.notes}
            </p>
          )}
        </section>
      )}

      {/* Pesos del ensemble actual */}
      {sources && sources.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">
            Pesos del ensemble actual
          </h2>
          <div className="space-y-2.5">
            {sources.map((src: any) => (
              <div key={src.slug} className="flex items-center gap-3">
                <span className="text-sm text-gray-400 w-36 shrink-0">{src.name}</span>
                <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-blue-500"
                    style={{ width: `${(src.weight * 100).toFixed(0)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400 w-10 text-right">
                  {(src.weight * 100).toFixed(0)}%
                </span>
                {src.rmse_365d && (
                  <span className="text-xs text-gray-600 w-20 text-right">
                    RMSE {src.rmse_365d.toFixed(2)}°C
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Historial de runs */}
      {allRuns && allRuns.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">
            Historial de backtests
          </h2>
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
              {allRuns.map((run: any) => (
                <tr key={run.id} className="border-b border-gray-800/50">
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
                      : <span className="text-red-500 text-xs">❌</span>
                    }
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
