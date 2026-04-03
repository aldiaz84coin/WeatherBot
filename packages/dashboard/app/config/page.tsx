// packages/dashboard/app/config/page.tsx

import { createClient }    from '@supabase/supabase-js'
import { BacktestRunner }  from '../../components/BacktestRunner'
import { MarketDataPanel } from '../../components/MarketDataPanel'
import { BotConfigPanel }  from '../../components/BotConfigPanel'

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
  const [sources, botConfig, cacheStats] = await Promise.all([
    getSources(),
    getBotConfig(),
    getMarketCacheStats(),
  ])

  const rawMode    = botConfig['betting_mode']?.value
  const bettingMode = rawMode === 'live' ? 'live' : 'simulated'
  const baseStake  = parseFloat(String(botConfig['base_stake_usdc']?.value ?? '20'))
  const maxStake   = parseFloat(String(botConfig['max_stake_usdc']?.value  ?? '160'))

  return (
    <div className="space-y-6">

      <div>
        <h1 className="text-2xl font-semibold text-white">Configuración y Backtest</h1>
        <p className="text-gray-400 text-sm mt-1">
          Control del bot, fuentes activas y lanzador de backtest
        </p>
      </div>

      <BotConfigPanel
        initialMode={bettingMode}
        initialBaseStake={baseStake}
        initialMaxStake={maxStake}
      />

      <BacktestRunner sources={sources} />

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
                ? `${Math.round((cacheStats.resolved / cacheStats.totalCached) * 100)}%`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Última fecha</p>
            <p className="text-xl font-bold text-white mt-0.5">
              {cacheStats.latest[0]?.market_date ?? '—'}
            </p>
          </div>
        </div>

        {cacheStats.latest.length > 0 && (
          <div className="border-t border-gray-800 pt-4">
            <p className="text-xs text-gray-500 mb-2">Últimas fechas en cache:</p>
            <div className="flex flex-wrap gap-2">
              {cacheStats.latest.map((d: { market_date: string; token_count: number }) => (
                <span
                  key={d.market_date}
                  className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded-md border border-gray-700"
                >
                  {d.market_date}
                  <span className="text-gray-600 ml-1">({d.token_count} tokens)</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <MarketDataPanel />

    </div>
  )
}
