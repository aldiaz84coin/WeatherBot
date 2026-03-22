'use client'

// packages/dashboard/app/comparison/page.tsx
// Página: Comparativa de fuentes meteo vs temperatura implícita de Polymarket
// – Últimos 8 días
// – Columna por fuente con Δ respecto al mercado
// – Sliders de pesos del ensemble configurables
// – Propuesta de pesos óptimos calculada por MAE inverso
// – Predicción ensemble para mañana

import { useState, useCallback, useEffect } from 'react'

// ─── Tipos (duplicados del route para no depender del servidor en cliente) ────

interface SourceResult { tmax: number | null; err: string | null }
interface DayRow {
  date: string
  polymarket: { temp: number | null; resolved: boolean; price: number | null; err: string | null }
  sources: {
    aemet: SourceResult
    openweather: SourceResult
    tomorrow: SourceResult
    visual_crossing: SourceResult
    weatherapi: SourceResult
    accuweather: SourceResult
    open_meteo: SourceResult
  }
}
interface TomorrowSources {
  date: string
  sources: DayRow['sources']
}
interface ComparisonResponse {
  rows: DayRow[]
  keysConfigured: Record<string, boolean>
  tomorrowSources?: TomorrowSources
}

// ─── Configuración de fuentes ─────────────────────────────────────────────────

const SOURCES = [
  { key: 'open_meteo',      name: 'Open-Meteo',      short: 'OM',  free: true  },
  { key: 'aemet',           name: 'AEMET',            short: 'AEM', free: false },
  { key: 'visual_crossing', name: 'Visual Crossing',  short: 'VCR', free: false },
  { key: 'weatherapi',      name: 'WeatherAPI',       short: 'WAP', free: false },
  { key: 'openweather',     name: 'OpenWeather',      short: 'OWM', free: false },
  { key: 'tomorrow',        name: 'Tomorrow.io',      short: 'TMR', free: false },
  { key: 'accuweather',     name: 'AccuWeather',      short: 'ACU', free: false },
] as const

type SourceKey = (typeof SOURCES)[number]['key']

const DEFAULT_WEIGHTS: Record<SourceKey, number> = {
  open_meteo:      0.15,
  aemet:           0.25,
  visual_crossing: 0.22,
  weatherapi:      0.15,
  openweather:     0.10,
  tomorrow:        0.08,
  accuweather:     0.05,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
}

function errColor(abs: number) {
  if (abs < 0.5)  return 'text-green-400'
  if (abs < 1.0)  return 'text-lime-400'
  if (abs < 1.8)  return 'text-yellow-400'
  if (abs < 3.0)  return 'text-orange-400'
  return 'text-red-400'
}

function computeWeighted(sources: DayRow['sources'], weights: Record<SourceKey, number>): number | null {
  let wSum = 0; let vSum = 0
  for (const s of SOURCES) {
    const v = sources[s.key]?.tmax
    if (typeof v === 'number' && !isNaN(v) && weights[s.key] > 0) {
      vSum += v * weights[s.key]; wSum += weights[s.key]
    }
  }
  if (wSum === 0) return null
  return Math.round(vSum / wSum * 10) / 10
}

function computeOptimalWeights(
  rows: DayRow[]
): { weights: Record<SourceKey, number>; maes: Record<SourceKey, number>; counts: Record<SourceKey, number> } | null {
  const errs: Partial<Record<SourceKey, number>> = {}
  const cnts: Partial<Record<SourceKey, number>> = {}
  for (const row of rows) {
    if (row.polymarket.temp === null) continue
    for (const s of SOURCES) {
      const v = row.sources[s.key]?.tmax
      if (typeof v !== 'number') continue
      errs[s.key] = (errs[s.key] ?? 0) + Math.abs(v - row.polymarket.temp!)
      cnts[s.key] = (cnts[s.key] ?? 0) + 1
    }
  }
  const maes: Partial<Record<SourceKey, number>> = {}
  let any = false
  for (const s of SOURCES) {
    const c = cnts[s.key]
    if (c) { maes[s.key] = errs[s.key]! / c; any = true }
  }
  if (!any) return null

  let tot = 0
  const invs: Partial<Record<SourceKey, number>> = {}
  for (const s of SOURCES) {
    const mae = maes[s.key]
    invs[s.key] = mae != null ? (mae > 0 ? 1 / mae : 10) : 0
    tot += invs[s.key]!
  }

  const optW = {} as Record<SourceKey, number>
  for (const s of SOURCES) {
    optW[s.key] = tot > 0 ? Math.round(invs[s.key]! / tot * 100) / 100 : 0
  }
  return { weights: optW, maes: maes as Record<SourceKey, number>, counts: cnts as Record<SourceKey, number> }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ComparisonPage() {
  const [weights, setWeights] = useState<Record<SourceKey, number>>({ ...DEFAULT_WEIGHTS })
  const [keyOverrides, setKeyOverrides] = useState<Partial<Record<SourceKey, string>>>({})
  const [showKeys, setShowKeys] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [data, setData] = useState<ComparisonResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keysConfigured, setKeysConfigured] = useState<Record<string, boolean>>({})
  const [savingWeights, setSavingWeights] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [tomorrowSources, setTomorrowSources] = useState<TomorrowSources | null>(null)

  // Cargar pesos actuales desde Supabase al montar
  useEffect(() => {
    fetch('/api/sources')
      .then(r => r.json())
      .then((d: any) => {
        if (d?.sources?.length) {
          const fromDb: Partial<Record<SourceKey, number>> = {}
          for (const s of d.sources) {
            const mapped = s.slug === 'visual-crossing' ? 'visual_crossing'
              : s.slug === 'openweathermap' ? 'openweather'
              : s.slug === 'tomorrow-io' ? 'tomorrow'
              : s.slug as SourceKey
            if (mapped in DEFAULT_WEIGHTS) fromDb[mapped as SourceKey] = s.weight
          }
          if (Object.keys(fromDb).length > 0) {
            setWeights(w => ({ ...w, ...fromDb }))
          }
        }
      })
      .catch(() => { /* pesos por defecto si falla */ })
  }, [])

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0)

  const normalize = useCallback(() => {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0)
    if (sum === 0) return
    setWeights(w => {
      const nw = { ...w }
      for (const k in nw) nw[k as SourceKey] = Math.round(nw[k as SourceKey] / sum * 100) / 100
      return nw
    })
  }, [weights])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    setProgress('Consultando Polymarket y fuentes meteorológicas…')
    try {
      const res = await fetch('/api/comparison', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyOverrides }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ComparisonResponse = await res.json()
      setData(json)
      setKeysConfigured(json.keysConfigured)
      setTomorrowSources(json.tomorrowSources ?? null)
      setProgress('')
    } catch (e: any) {
      setError(e.message ?? 'Error desconocido')
      setProgress('')
    } finally {
      setLoading(false)
    }
  }, [keyOverrides])

  const applyOptWeights = useCallback((optW: Record<SourceKey, number>) => {
    setWeights({ ...optW })
  }, [])

  const saveWeightsToSupabase = useCallback(async () => {
    setSavingWeights(true)
    try {
      // Mapear keys del frontend al slug de la BD
      const slugMap: Record<SourceKey, string> = {
        open_meteo: 'open-meteo', aemet: 'aemet', visual_crossing: 'visual-crossing',
        weatherapi: 'weatherapi', openweather: 'openweathermap', tomorrow: 'tomorrow-io',
        accuweather: 'accuweather',
      }
      const sourcesUpdate = SOURCES.map(s => ({
        slug: slugMap[s.key],
        weight: weights[s.key],
      }))
      const res = await fetch('/api/sources', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: sourcesUpdate }),
      })
      if (!res.ok) throw new Error('Error al guardar')
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 3000)
    } catch (e: any) {
      alert('Error guardando pesos: ' + e.message)
    } finally {
      setSavingWeights(false)
    }
  }, [weights])

  const opt = data ? computeOptimalWeights(data.rows) : null

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 space-y-6">

      {/* ── Cabecera ──────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-xl font-semibold text-white">Comparativa de fuentes</h1>
        <p className="text-sm text-gray-500 mt-1">
          Temperatura implícita de Polymarket vs previsiones meteorológicas · Madrid · Últimos 8 días
        </p>
      </div>

      {/* ── API Keys (colapsable) ─────────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <button
          onClick={() => setShowKeys(v => !v)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <span>{showKeys ? '▾' : '▸'}</span>
          <span>API Keys (opcional — sobreescribe las variables de entorno)</span>
        </button>

        {showKeys && (
          <div className="mt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {SOURCES.filter(s => !s.free).map(s => (
                <div key={s.key}>
                  <label className="block text-xs text-gray-500 mb-1">{s.name}</label>
                  <input
                    type="password"
                    placeholder={keysConfigured[s.key] ? '(configurada en Vercel)' : 'Pegar API key…'}
                    value={keyOverrides[s.key] ?? ''}
                    onChange={e => setKeyOverrides(v => ({ ...v, [s.key]: e.target.value }))}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white
                               placeholder-gray-600 focus:outline-none focus:border-blue-600"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Panel pesos ──────────────────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Pesos del ensemble</h2>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              Math.abs(weightSum - 1) < 0.02
                ? 'border-green-800 bg-green-950 text-green-400'
                : 'border-red-800 bg-red-950 text-red-400'
            }`}>
              Σ = {weightSum.toFixed(2)}
            </span>
            <button
              onClick={normalize}
              className="text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors"
            >
              Normalizar
            </button>
            <button
              onClick={saveWeightsToSupabase}
              disabled={savingWeights}
              className="text-xs px-2.5 py-1 rounded-lg border border-blue-800 bg-blue-950 text-blue-400 hover:bg-blue-900 transition-colors disabled:opacity-50"
            >
              {savingWeights ? 'Guardando…' : savedOk ? '✓ Guardado' : 'Guardar en BD'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-3">
          {SOURCES.map(s => (
            <div key={s.key} className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-28 flex-shrink-0">{s.name}</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={weights[s.key]}
                onChange={e => setWeights(w => ({ ...w, [s.key]: parseFloat(e.target.value) }))}
                className="flex-1 accent-blue-500"
              />
              <span className="text-xs text-white w-8 text-right flex-shrink-0">
                {Math.round(weights[s.key] * 100)}%
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Botón cargar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <button
          onClick={fetchData}
          disabled={loading}
          className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                     text-sm text-white font-medium transition-colors"
        >
          {loading ? 'Cargando…' : 'Cargar datos'}
        </button>
        {progress && <span className="text-sm text-gray-400 italic">{progress}</span>}
        {error && <span className="text-sm text-red-400">⚠ {error}</span>}
      </div>

      {/* ── Tabla comparativa ────────────────────────────────────────────── */}
      {data && (
        <>
          <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 whitespace-nowrap">Fecha</th>
                    <th className="px-4 py-3 text-xs font-medium text-yellow-500 whitespace-nowrap">
                      Polymarket<br />
                      <span className="text-gray-600 font-normal">implícita</span>
                    </th>
                    {SOURCES.map(s => (
                      <th key={s.key} className="px-3 py-3 text-xs font-medium text-gray-400 whitespace-nowrap">
                        {s.short}
                        {s.free
                          ? <span className="ml-1 text-green-600 text-[10px]">free</span>
                          : keysConfigured[s.key]
                            ? <span className="ml-1 text-green-600 text-[10px]">✓</span>
                            : <span className="ml-1 text-gray-600 text-[10px]">—</span>
                        }
                        <br />
                        <span className="text-gray-600 font-normal">{Math.round(weights[s.key] * 100)}%</span>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-xs font-medium text-blue-400 whitespace-nowrap">
                      Ensemble<br />
                      <span className="text-gray-600 font-normal">ponderado</span>
                    </th>
                    <th className="px-4 py-3 text-xs font-medium text-gray-400 whitespace-nowrap">
                      Δ vs poly
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => {
                    const pt = row.polymarket.temp
                    const weighted = computeWeighted(row.sources, weights)
                    const delta = weighted !== null && pt !== null
                      ? Math.round((weighted - pt) * 10) / 10
                      : null

                    return (
                      <tr key={row.date} className={i % 2 === 0 ? 'bg-gray-900' : 'bg-gray-950'}>
                        {/* Fecha */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <p className="text-white font-medium text-xs">{fmtDate(row.date)}</p>
                          <p className="text-gray-600 text-[10px]">{row.date}</p>
                        </td>

                        {/* Polymarket */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          {pt !== null ? (
                            <>
                              <span className="text-yellow-400 font-semibold">{pt}°C</span>
                              <br />
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                row.polymarket.resolved
                                  ? 'bg-green-950 text-green-400'
                                  : 'bg-yellow-950 text-yellow-600'
                              }`}>
                                {row.polymarket.resolved
                                  ? 'resuelto'
                                  : `~${Math.round((row.polymarket.price ?? 0) * 100)}%`}
                              </span>
                            </>
                          ) : (
                            <span className="text-red-500 text-xs"
                              title={row.polymarket.err ?? ''}>
                              {(row.polymarket.err ?? '—').substring(0, 20)}
                            </span>
                          )}
                        </td>

                        {/* Fuentes */}
                        {SOURCES.map(s => {
                          const sr = row.sources[s.key]
                          const v = sr?.tmax
                          const d = v !== null && pt !== null && v !== undefined
                            ? Math.round((v - pt) * 10) / 10
                            : null

                          return (
                            <td key={s.key} className="px-3 py-3 text-center whitespace-nowrap">
                              {v !== null && v !== undefined ? (
                                <>
                                  <span className={`font-medium text-sm ${d !== null ? errColor(Math.abs(d)) : 'text-white'}`}>
                                    {v}°C
                                  </span>
                                  {d !== null && (
                                    <span className={`block text-[10px] ${errColor(Math.abs(d))}`}>
                                      {d > 0 ? '+' : ''}{d}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span
                                  className="text-gray-600 text-[10px]"
                                  title={sr?.err ?? ''}
                                >
                                  {sr?.err ? '⚠' : '—'}
                                </span>
                              )}
                            </td>
                          )
                        })}

                        {/* Ensemble ponderado */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          {weighted !== null ? (
                            <span className="text-blue-400 font-semibold">{weighted}°C</span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>

                        {/* Δ vs Polymarket */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          {delta !== null ? (
                            <span className={`font-semibold ${errColor(Math.abs(delta))}`}>
                              {delta > 0 ? '+' : ''}{delta}°
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Leyenda */}
            <div className="px-4 py-2.5 border-t border-gray-800 flex flex-wrap gap-x-4 gap-y-1">
              {[
                { cls: 'text-green-400', label: '< 0.5°C' },
                { cls: 'text-lime-400',  label: '0.5 – 1°C' },
                { cls: 'text-yellow-400', label: '1 – 1.8°C' },
                { cls: 'text-orange-400', label: '1.8 – 3°C' },
                { cls: 'text-red-400',   label: '> 3°C' },
              ].map(l => (
                <span key={l.cls} className="text-[10px] text-gray-500">
                  <span className={l.cls}>■</span> {l.label}
                </span>
              ))}
              <span className="text-[10px] text-gray-600">
                · Δ = fuente − temperatura implícita Polymarket
              </span>
            </div>
          </section>

          {/* ── Predicción para mañana ──────────────────────────────────── */}
          {tomorrowSources && (() => {
            const ensemble = computeWeighted(tomorrowSources.sources, weights)
            return (
              <section className="bg-gray-900 border border-blue-900/50 rounded-xl p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-blue-300 flex items-center gap-2">
                      🔮 Predicción para mañana
                      <span className="text-gray-500 font-normal text-xs">
                        {tomorrowSources.date}
                      </span>
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Ensemble ponderado con los pesos configurados arriba.
                      Open-Meteo siempre disponible; el resto requiere API key.
                    </p>
                  </div>
                  {ensemble !== null && (
                    <div className="text-right shrink-0">
                      <p className="text-3xl font-bold text-blue-400 leading-none">
                        {ensemble}°C
                      </p>
                      <p className="text-xs text-gray-500 mt-1">Tmax estimada</p>
                    </div>
                  )}
                </div>

                {/* Detalle por fuente */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
                  {SOURCES.map(s => {
                    const sr = tomorrowSources.sources[s.key]
                    const v = sr?.tmax
                    const w = weights[s.key]
                    return (
                      <div
                        key={s.key}
                        className={`rounded-lg px-3 py-2 border text-center ${
                          v !== null
                            ? 'bg-gray-800 border-gray-700'
                            : 'bg-gray-950 border-gray-800 opacity-50'
                        }`}
                      >
                        <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">
                          {s.short}
                        </p>
                        {v !== null ? (
                          <>
                            <p className="text-base font-bold text-white mt-0.5">{v}°C</p>
                            <p className="text-[10px] text-gray-500">{Math.round(w * 100)}%</p>
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-gray-600 mt-1">—</p>
                            <p
                              className="text-[10px] text-gray-700 mt-0.5 truncate"
                              title={sr?.err ?? ''}
                            >
                              {sr?.err?.substring(0, 14) ?? 'sin datos'}
                            </p>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>

                {ensemble === null && (
                  <p className="text-xs text-yellow-600 mt-3">
                    ⚠ Sin datos suficientes para calcular el ensemble (ninguna fuente devolvió previsión para mañana).
                  </p>
                )}
              </section>
            )
          })()}

          {/* ── Propuesta de pesos óptimos ──────────────────────────────── */}
          {opt && (
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium text-gray-300">Pesos óptimos propuestos</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Calculados por MAE inverso vs temperatura implícita de Polymarket.
                    Menor error → mayor peso.
                  </p>
                </div>
                <button
                  onClick={() => applyOptWeights(opt.weights)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-green-950 border border-green-800 text-green-400 hover:bg-green-900 transition-colors"
                >
                  Aplicar pesos
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
                {SOURCES.map(s => {
                  const mae = opt.maes[s.key]
                  const cnt = opt.counts[s.key]
                  const w = opt.weights[s.key]
                  return (
                    <div key={s.key} className="bg-gray-800 rounded-lg px-3 py-2 text-center">
                      <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{s.short}</p>
                      <p className="text-base font-bold text-white mt-0.5">{Math.round(w * 100)}%</p>
                      {mae != null ? (
                        <p className={`text-[10px] mt-0.5 ${errColor(mae)}`}>
                          MAE {mae.toFixed(1)}° ({cnt}d)
                        </p>
                      ) : (
                        <p className="text-[10px] text-gray-600 mt-0.5">sin datos</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
