'use client'

// packages/dashboard/app/research-markets/page.tsx
//
// Investigación de mercados: Londres · Milán · Múnich · Moscú.
//
// ⚠ SIMULACIÓN AISLADA — no afecta al bot real de Madrid ni a su
// ensemble/pesos/bias. Escribe únicamente en research_predictions.

import { useState, useCallback, useEffect } from 'react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface SourceResult { tmax: number | null; err: string | null }
interface DayRow {
  date: string
  actual:     { tmax: number | null; err: string | null }
  polymarket: { temp: number | null; resolved: boolean; price: number | null; err: string | null }
  sources: Record<SourceKey, SourceResult>
}
interface TomorrowSources { date: string; sources: Record<SourceKey, SourceResult> }
interface ResearchResponse {
  city: { key: string; name: string; tz: string; slug: string }
  rows: DayRow[]
  tomorrowSources: TomorrowSources
  tomorrowPolymarket: DayRow['polymarket']
}
interface PersistedRow {
  id: string; city: string; target_date: string
  source_temps: Record<string, number>
  weights_used: Record<string, number>
  bias_n_used: number
  ensemble_temp: number | null
  token_a: number | null; token_b: number | null
  actual_tmax: number | null; settled: boolean
  hit_token: 'a' | 'b' | null
  polymarket_temp: number | null; polymarket_price: number | null; polymarket_resolved: boolean
}
interface HitRate {
  city: string; total_settled: number; hits: number; hits_a: number; hits_b: number
  misses: number; hit_rate_pct: number | null
  earliest_settled: string | null; latest_settled: string | null; pending: number
}
interface SourceMae { city: string; source: string; n: number; mae: number; bias: number }

// ─── Config ──────────────────────────────────────────────────────────────────

const CITIES = [
  { key: 'london', name: 'Londres', flag: '🇬🇧' },
  { key: 'milan',  name: 'Milán',   flag: '🇮🇹' },
  { key: 'munich', name: 'Múnich',  flag: '🇩🇪' },
  { key: 'moscow', name: 'Moscú',   flag: '🇷🇺' },
] as const
type CityKey = (typeof CITIES)[number]['key']

const SOURCES = [
  { key: 'open_meteo',      name: 'Open-Meteo',      short: 'OM'  },
  { key: 'visual_crossing', name: 'Visual Crossing', short: 'VCR' },
  { key: 'weatherapi',      name: 'WeatherAPI',      short: 'WAP' },
  { key: 'openweather',     name: 'OpenWeather',     short: 'OWM' },
  { key: 'tomorrow',        name: 'Tomorrow.io',     short: 'TMR' },
] as const
type SourceKey = (typeof SOURCES)[number]['key']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(s: string) {
  const d = new Date(s + 'T12:00:00')
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
}
function errColor(abs: number) {
  if (abs < 0.5) return 'text-green-400'
  if (abs < 1.0) return 'text-lime-400'
  if (abs < 1.8) return 'text-yellow-400'
  if (abs < 3.0) return 'text-orange-400'
  return 'text-red-400'
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function ResearchMarketsPage() {
  const [city, setCity] = useState<CityKey>('london')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ResearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Persistencia
  const [hitRates, setHitRates] = useState<HitRate[]>([])
  const [persisted, setPersisted] = useState<PersistedRow[]>([])
  const [sourceMae, setSourceMae] = useState<SourceMae[]>([])
  const [opLoading, setOpLoading] = useState<'snapshot' | 'settle' | null>(null)
  const [opMsg, setOpMsg] = useState<string | null>(null)

  // ── Live fetch al cambiar ciudad ────────────────────────────────────────────
  const loadLive = useCallback(async (c: CityKey) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/research-markets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: c }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setData(json)
    } catch (e: any) { setError(e.message ?? 'Error') }
    finally { setLoading(false) }
  }, [])

  // ── Persistencia ────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async (c: CityKey) => {
    try {
      const res = await fetch(`/api/research-markets/history?city=${c}&limit=60`)
      const json = await res.json()
      if (res.ok) {
        setPersisted(json.rows ?? [])
        setSourceMae(json.sourceMae ?? [])
      }
    } catch {}
  }, [])

  const loadAllHitRates = useCallback(async () => {
    try {
      const res = await fetch('/api/research-markets/history', { method: 'POST' })
      const json = await res.json()
      if (res.ok) setHitRates(json.hitRates ?? [])
    } catch {}
  }, [])

  useEffect(() => { loadLive(city); loadHistory(city) }, [city, loadLive, loadHistory])
  useEffect(() => { loadAllHitRates() }, [loadAllHitRates])

  // ── Acciones ────────────────────────────────────────────────────────────────
  const snapshotNow = useCallback(async () => {
    setOpLoading('snapshot'); setOpMsg(null)
    try {
      const res = await fetch('/api/research-markets/snapshot', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error')
      const ok = json.results.filter((r: any) => r.status === 'ok').length
      const partial = json.results.filter((r: any) => r.status === 'partial').length
      const err = json.results.filter((r: any) => r.status === 'error').length
      setOpMsg(`✓ Snapshot: ${ok} ok, ${partial} parcial, ${err} error`)
      await loadHistory(city); await loadAllHitRates()
    } catch (e: any) { setOpMsg(`⚠ ${e.message}`) }
    finally { setOpLoading(null) }
  }, [city, loadHistory, loadAllHitRates])

  const settleNow = useCallback(async () => {
    setOpLoading('settle'); setOpMsg(null)
    try {
      const res = await fetch('/api/research-markets/settle', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error')
      setOpMsg(`✓ Liquidadas: ${json.settled} · pendientes ERA5: ${json.pending_era5} · futuras: ${json.still_future ?? 0}`)
      await loadHistory(city); await loadAllHitRates()
    } catch (e: any) { setOpMsg(`⚠ ${e.message}`) }
    finally { setOpLoading(null) }
  }, [city, loadHistory, loadAllHitRates])

  // ── Ensemble EN VIVO con los pesos del primer row persistido (si existe) ────
  // Si no hay nada persistido, mostramos "—" para no inventar pesos.
  const latestSnapshot = persisted[0] ?? null
  const weightsLive: Record<SourceKey, number> | null = latestSnapshot?.weights_used
    ? { ...(latestSnapshot.weights_used as Record<SourceKey, number>) } : null

  const computeEns = (srcs: Record<SourceKey, SourceResult>): number | null => {
    if (!weightsLive) return null
    let w = 0, v = 0
    for (const s of SOURCES) {
      const t = srcs[s.key]?.tmax
      const wt = weightsLive[s.key] ?? 0
      if (typeof t === 'number' && wt > 0) { v += t * wt; w += wt }
    }
    return w > 0 ? Math.round(v / w * 10) / 10 : null
  }

  const ensembleTomorrow = data && weightsLive ? computeEns(data.tomorrowSources.sources) : null
  const biasN = latestSnapshot?.bias_n_used ?? 0
  const tokenA = ensembleTomorrow != null ? Math.ceil(ensembleTomorrow + biasN) : null
  const tokenB = tokenA != null ? tokenA + 1 : null

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Banner de simulación */}
      <div className="bg-amber-950/40 border border-amber-900/60 rounded-lg px-4 py-3 flex items-start gap-3">
        <span className="text-amber-400 text-lg">⚠</span>
        <div className="text-sm">
          <div className="font-semibold text-amber-200">Simulación aislada</div>
          <div className="text-amber-300/80">
            Esta pestaña no afecta al bot real de Madrid. No ejecuta órdenes, no modifica
            pesos ni bias, y persiste solo en <code className="font-mono text-xs">research_predictions</code>.
            El ensemble se calcula con pesos <strong>renormalizados sobre 5 fuentes</strong>
            (sin AEMET ni AccuWeather) — etiquetado como <em>sesgado</em>.
          </div>
        </div>
      </div>

      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">🔬 Investigación de mercados</h1>
          <p className="text-sm text-gray-400">
            Simulación del algoritmo en 4 ciudades europeas · snapshot diario + settlement ERA5
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={snapshotNow}
            disabled={opLoading !== null}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
          >
            {opLoading === 'snapshot' ? 'Snapshotting…' : '📸 Snapshot mañana'}
          </button>
          <button
            onClick={settleNow}
            disabled={opLoading !== null}
            className="px-3 py-1.5 text-sm rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-medium"
          >
            {opLoading === 'settle' ? 'Liquidando…' : '✓ Liquidar pendientes'}
          </button>
        </div>
      </header>

      {opMsg && <div className="text-sm text-gray-300 bg-gray-900 border border-gray-800 rounded px-3 py-2">{opMsg}</div>}

      {/* Resumen hit rate TODAS las ciudades */}
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Hit rate histórico por mercado</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {CITIES.map(c => {
            const hr = hitRates.find(h => h.city === c.key)
            return (
              <div key={c.key} className="bg-gray-950 rounded p-4 border border-gray-800">
                <div className="text-sm text-gray-400 mb-1">{c.flag} {c.name}</div>
                {hr && hr.total_settled > 0 ? (
                  <>
                    <div className={`text-3xl font-mono ${
                      hr.hit_rate_pct && hr.hit_rate_pct >= 50 ? 'text-green-400' : 'text-orange-400'
                    }`}>
                      {hr.hit_rate_pct}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {hr.hits}/{hr.total_settled} · A:{hr.hits_a} B:{hr.hits_b}
                    </div>
                    <div className="text-[10px] text-gray-600">pendientes: {hr.pending}</div>
                  </>
                ) : (
                  <div className="text-sm text-gray-600 mt-2">Sin datos liquidados</div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Selector */}
      <div className="flex gap-2 flex-wrap">
        {CITIES.map(c => (
          <button key={c.key} onClick={() => setCity(c.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              city === c.key ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}>
            {c.flag} {c.name}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-400 text-sm">Consultando fuentes…</div>}
      {error && <div className="text-red-400 text-sm">⚠ {error}</div>}

      {/* Predicción de mañana (live) */}
      {data && !loading && (
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              Predicción viva para {fmtDate(data.tomorrowSources.date)} · {data.city.name}
            </h2>
            <span className="text-xs text-gray-500 font-mono">{data.city.tz}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            {SOURCES.map(s => {
              const v = data.tomorrowSources.sources[s.key]
              return (
                <div key={s.key} className="bg-gray-950 rounded p-3 border border-gray-800">
                  <div className="text-xs text-gray-500">{s.short}</div>
                  <div className="text-lg font-mono text-gray-100">
                    {v?.tmax != null ? `${v.tmax.toFixed(1)}°` : <span className="text-gray-600">—</span>}
                  </div>
                  {v?.err && <div className="text-[10px] text-red-400 truncate">{v.err}</div>}
                </div>
              )
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-gray-800">
            <div>
              <div className="text-xs text-gray-500">Ensemble sesgado</div>
              <div className="text-2xl font-mono text-blue-400">
                {ensembleTomorrow != null ? `${ensembleTomorrow.toFixed(1)}°C` : '—'}
              </div>
              <div className="text-[10px] text-gray-500">
                {weightsLive ? `pesos últimos snapshot · N=${biasN >= 0 ? '+' : ''}${biasN.toFixed(1)}` : 'pulsa "Snapshot" para fijar pesos'}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Tokens A / B</div>
              <div className="text-2xl font-mono text-white">
                {tokenA != null ? `${tokenA}°C · ${tokenB}°C` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Mercado Polymarket</div>
              {data.tomorrowPolymarket.temp != null ? (
                <>
                  <div className="text-2xl font-mono text-purple-400">{data.tomorrowPolymarket.temp}°C</div>
                  <div className="text-[10px] text-gray-500">precio {data.tomorrowPolymarket.price?.toFixed(3) ?? '—'}</div>
                </>
              ) : (
                <div className="text-sm text-gray-600 mt-1">{data.tomorrowPolymarket.err ?? 'Sin mercado'}</div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* MAE por fuente (persistido) */}
      {sourceMae.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h2 className="text-lg font-semibold text-white mb-3">MAE por fuente vs ERA5 (liquidados)</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {SOURCES.map(s => {
              const m = sourceMae.find(x => x.source === s.key)
              return (
                <div key={s.key} className="bg-gray-950 rounded p-3 border border-gray-800">
                  <div className="text-xs text-gray-500">{s.short}</div>
                  <div className={`text-lg font-mono ${m ? errColor(m.mae) : 'text-gray-600'}`}>
                    {m ? `${m.mae.toFixed(2)}°` : '—'}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {m ? `n=${m.n} · sesgo ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(2)}` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Historial persistido */}
      {persisted.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-5 overflow-x-auto">
          <h2 className="text-lg font-semibold text-white mb-3">
            Historial persistido · {persisted.length} snapshots
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="py-2 pr-3">Fecha</th>
                <th className="py-2 px-2 text-right">Ens.</th>
                <th className="py-2 px-2 text-right">N</th>
                <th className="py-2 px-2 text-right">A / B</th>
                <th className="py-2 px-2 text-right">Real</th>
                <th className="py-2 px-2 text-center">Hit</th>
                <th className="py-2 px-2 text-right text-purple-400">Poly</th>
              </tr>
            </thead>
            <tbody>
              {persisted.map(r => (
                <tr key={r.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-2 pr-3 text-gray-300">{fmtDate(r.target_date)}</td>
                  <td className="py-2 px-2 text-right font-mono text-blue-400">
                    {r.ensemble_temp != null ? Number(r.ensemble_temp).toFixed(1) : '—'}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-gray-400">
                    {r.bias_n_used >= 0 ? '+' : ''}{Number(r.bias_n_used).toFixed(1)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-gray-200">
                    {r.token_a}/{r.token_b}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-white">
                    {r.actual_tmax != null ? Number(r.actual_tmax).toFixed(1) : '—'}
                  </td>
                  <td className="py-2 px-2 text-center">
                    {!r.settled ? <span className="text-gray-600 text-xs">pend</span>
                      : r.hit_token === 'a' ? <span className="text-green-400 font-mono text-xs">A ✓</span>
                      : r.hit_token === 'b' ? <span className="text-green-400 font-mono text-xs">B ✓</span>
                      : <span className="text-red-400 text-xs">miss</span>}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-purple-400">
                    {r.polymarket_temp != null ? r.polymarket_temp : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {persisted.length === 0 && !loading && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 text-sm text-gray-400">
          Sin snapshots persistidos aún. Pulsa <strong className="text-white">📸 Snapshot mañana</strong> para
          empezar a acumular datos.
        </div>
      )}
    </div>
  )
}
