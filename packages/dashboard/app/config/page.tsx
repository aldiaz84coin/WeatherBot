// app/config/page.tsx
// Panel de control principal: fuentes, parámetros y lanzador de backtest.
// Combina un server component (para datos iniciales) con el cliente interactivo.

import { createClient } from '@supabase/supabase-js'
import { BacktestRunner } from '../../components/BacktestRunner'
import { MarketDataPanel } from '../../components/MarketDataPanel'

export const revalidate = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

async function getSources() {
  const { data } = await supabase
    .from('weather_sources')
    .select('*')
    .order('rmse_365d', { ascending: true, nullsFirst: false })
  return data ?? []
}

async function getRecentJobs() {
  const { data } = await supabase
    .from('backtest_jobs')
    .select('id, status, created_at, started_at, finished_at, config, result')
    .order('created_at', { ascending: false })
    .limit(5)
  return data ?? []
}

async function getBotConfig() {
  const { data } = await supabase.from('bot_config').select('key, value, description')
  return Object.fromEntries((data ?? []).map(r => [r.key, r]))
}

async function getMarketCacheStats() {
  const { count: totalCached } = await supabase
    .from('market_data_cache')
    .select('*', { count: 'exact', head: true })

  const { count: resolved } = await supabase
    .from('market_data_cache')
    .select('*', { count: 'exact', head: true })
    .not('payload->resolvedTemp', 'is', null)

  const { data: latest } = await supabase
    .from('market_data_cache')
    .select('market_date, token_count, fetched_at')
    .order('market_date', { ascending: false })
    .limit(5)

  return { totalCached: totalCached ?? 0, resolved: resolved ?? 0, latest: latest ?? [] }
}

export default async function ConfigPage() {
  const [sources, recentJobs, botConfig, cacheStats] = await Promise.all([
    getSources(),
    getRecentJobs(),
    getBotConfig(),
    getMarketCacheStats(),
  ])

  const budget = parseFloat(botConfig['daily_budget_usdc']?.value ?? '0.80')

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Configuración y Backtest</h1>
        <p className="text-gray-400 text-sm mt-1">
          Configura las fuentes, parámetros y lanza el backtest de la Fase 1
        </p>
      </div>

      {/* ── Objetivo de la Fase 1 ───────────────────────────────────────── */}
      <section className="bg-gray-900 border-2 border-dashed border-yellow-900/60 rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className="text-2xl">⭐</div>
          <div className="flex-1 min-w-0">

            <h2 className="text-yellow-500 font-semibold text-sm mb-2">Objetivo de la Fase 1</h2>

            {/* Descripción principal */}
            <p className="text-gray-300 text-sm leading-relaxed mb-3">
              Comprar <strong className="text-white">N tokens</strong> de cada una de las 3
              temperaturas candidatas en Polymarket, donde la{' '}
              <strong className="text-white">
                suma de precios unitarios &lt; {budget} USDC
              </strong>.{' '}
              Si algún token resuelve en YES (temperatura real), los N tokens ganadores valen{' '}
              <strong className="text-white">N × 1 USDC</strong>, cubriendo el coste total y
              garantizando una ganancia mínima de{' '}
              <strong className="text-green-400">
                N × {(1 - budget).toFixed(2)} USDC
              </strong>.
            </p>

            {/* Ejemplo visual */}
            <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 mb-3">
              <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">
                Ejemplo — Predicción: 19 °C
              </p>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {/* Tokens */}
                <div className="flex-1 min-w-[5rem] text-center px-2 py-2 rounded-lg border border-gray-600 text-gray-400 bg-gray-900">
                  <p className="text-sm font-bold">18 °C</p>
                  <p className="text-xs opacity-60 mt-0.5">pred − 1°</p>
                </div>
                <div className="flex-1 min-w-[5rem] text-center px-2 py-2 rounded-lg border border-yellow-700 text-yellow-300 bg-gray-900">
                  <p className="text-sm font-bold">19 °C</p>
                  <p className="text-xs opacity-60 mt-0.5">pred</p>
                </div>
                <div className="flex-1 min-w-[5rem] text-center px-2 py-2 rounded-lg border border-gray-600 text-gray-400 bg-gray-900">
                  <p className="text-sm font-bold">20 °C</p>
                  <p className="text-xs opacity-60 mt-0.5">pred + 1°</p>
                </div>

                {/* Flecha */}
                <div className="text-gray-600 text-lg hidden sm:block">→</div>

                {/* Resultado */}
                <div className="flex-1 min-w-[7rem] text-center px-2 py-2 rounded-lg border border-green-800 bg-green-950/40">
                  <p className="text-xs text-green-400 font-medium">Si resuelve 18, 19 ó 20</p>
                  <p className="text-sm text-green-300 font-bold mt-0.5">N × 1 USDC ✓</p>
                  <p className="text-xs text-gray-500 mt-0.5">los otros 2 → 0</p>
                </div>
              </div>

              {/* Fórmula */}
              <div className="mt-2 pt-2 border-t border-gray-800 grid grid-cols-1 sm:grid-cols-3 gap-1 text-xs text-gray-500">
                <span>
                  <strong className="text-gray-300">N</strong>{' '}
                  = {budget} ÷ (p₁₈ + p₁₉ + p₂₀)
                </span>
                <span>
                  <strong className="text-gray-300">Coste total</strong>{' '}
                  = N × suma precios = {budget} USDC
                </span>
                <span>
                  <strong className="text-green-400">Ganancia mín.</strong>{' '}
                  = N × (1 − suma) {'>'} N × {(1 - budget).toFixed(2)}
                </span>
              </div>
            </div>

            {/* Criterio de validación + budget */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span className="text-gray-500">
                🎯 Criterio:{' '}
                <strong className="text-white">≥ 90% hit rate en los últimos 90 días (OOS)</strong>
              </span>
              <span className="text-gray-500">
                💰 Budget diario seleccionable —{' '}
                <strong className="text-white">
                  suma unitaria debe ser &lt; {budget} USDC
                </strong>
              </span>
            </div>

          </div>
        </div>
      </section>

      {/* ── Panel interactivo de backtest ───────────────────────────────── */}
      <BacktestRunner sources={sources} />

      {/* ── Estado del cache de mercados ───────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-300 mb-4">Cache de datos Polymarket</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-xs text-gray-500">Días en cache</p>
            <p className="text-xl font-bold text-white mt-0.5">{cacheStats.totalCached}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Días resueltos</p>
            <p className="text-xl font-bold text-white mt-0.5">{cacheStats.resolved}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Cobertura</p>
            <p className="text-xl font-bold text-white mt-0.5">
              {cacheStats.totalCached > 0
                ? `${((cacheStats.resolved / cacheStats.totalCached) * 100).toFixed(0)}%`
                : '—'}
            </p>
            <p className="text-xs text-gray-600">resueltos/total</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Última fecha cacheada</p>
            <p className="text-sm font-medium text-white mt-0.5">
              {cacheStats.latest[0]?.market_date ?? '—'}
            </p>
          </div>
        </div>

        {/* Últimas entradas del cache */}
        {cacheStats.latest.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-gray-600 mb-2">Últimas fechas en cache:</p>
            {cacheStats.latest.map((entry: any) => (
              <div
                key={entry.market_date}
                className="flex items-center justify-between text-xs py-1 border-b border-gray-800/50"
              >
                <span className="text-gray-300">{entry.market_date}</span>
                <span className="text-gray-500">{entry.token_count} tokens</span>
                <span className="text-gray-600">
                  {new Date(entry.fetched_at).toLocaleString('es-ES', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Historial de jobs ────────────────────────────────────────────── */}
      {recentJobs.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-300 mb-4">Historial de backtests</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 pr-4 font-normal">Fecha</th>
                <th className="text-left py-2 pr-4 font-normal">Rango</th>
                <th className="text-right py-2 pr-4 font-normal">Hit rate</th>
                <th className="text-right py-2 pr-4 font-normal">Profit</th>
                <th className="text-right py-2 font-normal">Estado</th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((job: any) => (
                <tr key={job.id} className="border-b border-gray-800/50">
                  <td className="py-2.5 pr-4 text-gray-400 text-xs">
                    {new Date(job.created_at).toLocaleString('es-ES', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-400 text-xs">
                    {job.config?.start_date} → {job.config?.end_date}
                  </td>
                  <td className="py-2.5 pr-4 text-right">
                    {job.result?.hitRate != null ? (
                      <span className={
                        job.result.passed ? 'text-green-400 font-medium' : 'text-red-400 font-medium'
                      }>
                        {(job.result.hitRate * 100).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-right">
                    {job.result?.totalProfit != null ? (
                      <span className={job.result.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {job.result.totalProfit >= 0 ? '+' : ''}{job.result.totalProfit} USDC
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      job.status === 'done' && job.result?.passed
                        ? 'bg-green-950 text-green-400'
                        : job.status === 'done'
                          ? 'bg-red-950 text-red-400'
                          : job.status === 'running' || job.status === 'pending'
                            ? 'bg-blue-950 text-blue-400'
                            : 'bg-red-950 text-red-400'
                    }`}>
                      {job.status === 'done' && job.result?.passed ? '✅'
                        : job.status === 'done' ? '❌'
                        : job.status === 'running' ? '⏳'
                        : job.status === 'pending' ? '⏸'
                        : '⚠'}
                      {' '}{job.status}
                    </span>
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
