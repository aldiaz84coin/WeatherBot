'use client'

// packages/dashboard/app/comparison/page.tsx
// Página: Comparativa de fuentes meteo vs temperatura implícita de Polymarket
// – Últimos 8 días
// – Columna por fuente con Δ respecto al mercado
// – Sliders de pesos del ensemble configurables
// – Propuesta de pesos óptimos calculada por MAE inverso
// – Predicción ensemble para mañana
// – ⭐ Registro de operación simulada: guarda pesos + predicción + trades en BD

import { useState, useCallback, useEffect } from 'react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface SourceResult { tmax: number | null; err: string | null }
interface DayRow {
  date: string
  polymarket: { temp: number | null; resolved: boolean; price: number | null; err: string | null }
  sources: {
    aemet: SourceResult; openweather: SourceResult; tomorrow: SourceResult
    visual_crossing: SourceResult; weatherapi: SourceResult
    accuweather: SourceResult; open_meteo: SourceResult
  }
}
interface TomorrowSources { date: string; sources: DayRow['sources'] }
interface ComparisonResponse {
  rows: DayRow[]
  keysConfigured: Record<string, boolean>
  tomorrowSources?: TomorrowSources
}

// Resultado de guardar la operación
interface SavedOperation {
  predictionId: string
  targetDate:   string
  ensembleTemp: number
  tokenA: { temp: number; slug: string; price: number | null; shares: number | null; cost: number }
  tokenB: { temp: number; slug: string; price: number | null; shares: number | null; cost: number }
  stake:  number
  isUpdate: boolean
}

// ─── Configuración de fuentes ─────────────────────────────────────────────────

const SOURCES = [
  { key: 'open_meteo',      name: 'Open-Meteo',     short: 'OM',  free: true  },
  { key: 'aemet',           name: 'AEMET',           short: 'AEM', free: false },
  { key: 'visual_crossing', name: 'Visual Crossing', short: 'VCR', free: false },
  { key: 'weatherapi',      name: 'WeatherAPI',      short: 'WAP', free: false },
  { key: 'openweather',     name: 'OpenWeather',     short: 'OWM', free: false },
  { key: 'tomorrow',        name: 'Tomorrow.io',     short: 'TMR', free: false },
  { key: 'accuweather',     name: 'AccuWeather',     short: 'ACU', free: false },
] as const

type SourceKey = (typeof SOURCES)[number]['key']

const DEFAULT_WEIGHTS: Record<SourceKey, number> = {
  open_meteo: 0.15, aemet: 0.25, visual_crossing: 0.22,
  weatherapi: 0.15, openweather: 0.10, tomorrow: 0.08, accuweather: 0.05,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
}

function errColor(abs: number | null) {
  if (abs === null) return 'text-gray-600'
  if (abs <= 1)  return 'text-green-400'
  if (abs <= 2)  return 'text-yellow-400'
  return 'text-red-400'
}

function getTomorrowDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ComparisonPage() {
  const [data,           setData]           = useState<ComparisonResponse | null>(null)
  const [tomorrowSources, setTomorrowSources] = useState<TomorrowSources | null>(null)
  const [loading,        setLoading]        = useState(false)
  const [error,          setError]          = useState<string | null>(null)
  const [progress,       setProgress]       = useState('')
  const [weights,        setWeights]        = useState<Record<SourceKey, number>>(DEFAULT_WEIGHTS)
  const [keyOverrides,   setKeyOverrides]   = useState<Record<string, string>>({})
  const [showKeys,       setShowKeys]       = useState(false)
  const [keysConfigured, setKeysConfigured] = useState<Record<string, boolean>>({})
  const [savingWeights,  setSavingWeights]  = useState(false)
  const [savedOk,        setSavedOk]        = useState(false)

  // ── Estado de la operación ──────────────────────────────────────────────────
  const [stake,           setStake]           = useState(20)
  const [savingOp,        setSavingOp]        = useState(false)
  const [savedOp,         setSavedOp]         = useState<SavedOperation | null>(null)
  const [saveOpError,     setSaveOpError]     = useState<string | null>(null)

  // ── Cargar pesos desde la BD al montar ──────────────────────────────────────
  useEffect(() => {
    fetch('/api/sources')
      .then(r => r.json())
      .then(d => {
        if (d.sources?.length) {
          const fromDb: Partial<Record<SourceKey, number>> = {}
          for (const s of d.sources) {
            const mapped =
              s.slug === 'visual-crossing' ? 'visual_crossing'
              : s.slug === 'openweathermap' ? 'openweather'
              : s.slug === 'tomorrow-io'    ? 'tomorrow'
              : s.slug as SourceKey
            if (mapped in DEFAULT_WEIGHTS) fromDb[mapped as SourceKey] = s.weight
          }
          if (Object.keys(fromDb).length > 0)
            setWeights(w => ({ ...w, ...fromDb }))
        }
      })
      .catch(() => {})
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
    setLoading(true); setError(null); setSavedOp(null)
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
      setError(e.message ?? 'Error desconocido'); setProgress('')
    } finally {
      setLoading(false)
    }
  }, [keyOverrides])

  const applyOptWeights = useCallback((optW: Record<SourceKey, number>) => {
    setWeights({ ...optW })
  }, [])

  // ── Guardar pesos en Supabase ───────────────────────────────────────────────
  const saveWeightsToSupabase = useCallback(async () => {
    setSavingWeights(true)
    try {
      const slugMap: Record<SourceKey, string> = {
        open_meteo: 'open-meteo', aemet: 'aemet', visual_crossing: 'visual-crossing',
        weatherapi: 'weatherapi', openweather: 'openweathermap', tomorrow: 'tomorrow-io',
        accuweather: 'accuweather',
      }
      const sourcesUpdate = SOURCES.map(s => ({ slug: slugMap[s.key], weight: weights[s.key] }))
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

  // ── Calcular ensemble con los pesos actuales ────────────────────────────────
  const computeEnsemble = useCallback((sources: TomorrowSources['sources']): number | null => {
    let weightedSum = 0, totalW = 0
    for (const s of SOURCES) {
      const v = sources[s.key]?.tmax
      if (v !== null && v !== undefined) {
        weightedSum += v * weights[s.key]
        totalW      += weights[s.key]
      }
    }
    if (totalW === 0) return null
    return Math.round((weightedSum / totalW) * 10) / 10
  }, [weights])

  // ── Calcular pesos óptimos por MAE inverso (últimos 8 días) ────────────────
  const opt = data ? (() => {
    const maes:   Partial<Record<SourceKey, number>> = {}
    const counts: Partial<Record<SourceKey, number>> = {}
    for (const row of data.rows) {
      const ref = row.polymarket.temp
      if (ref === null) continue
      for (const s of SOURCES) {
        const v = row.sources[s.key]?.tmax
        if (v === null || v === undefined) continue
        maes[s.key]   = (maes[s.key]   ?? 0) + Math.abs(v - ref)
        counts[s.key] = (counts[s.key] ?? 0) + 1
      }
    }
    const avgMae: Partial<Record<SourceKey, number>> = {}
    for (const s of SOURCES) {
      if (counts[s.key]) avgMae[s.key] = maes[s.key]! / counts[s.key]!
    }
    const inverted: Partial<Record<SourceKey, number>> = {}
    for (const s of SOURCES) {
      if (avgMae[s.key] !== undefined) inverted[s.key] = avgMae[s.key]! > 0 ? 1 / avgMae[s.key]! : 0
    }
    const total = Object.values(inverted).reduce((a, b) => a + b, 0)
    const optWeights: Record<SourceKey, number> = { ...DEFAULT_WEIGHTS }
    if (total > 0) {
      for (const s of SOURCES) {
        optWeights[s.key] = Math.round((inverted[s.key] ?? 0) / total * 100) / 100
      }
    }
    return { weights: optWeights, maes: avgMae, counts }
  })() : null

  // ── ⭐ Registrar operación simulada ─────────────────────────────────────────
  const registerOperation = useCallback(async () => {
    if (!tomorrowSources) return
    const ensemble = computeEnsemble(tomorrowSources.sources)
    if (ensemble === null) {
      setSaveOpError('Sin datos de fuentes para calcular el ensemble.')
      return
    }

    setSavingOp(true); setSaveOpError(null); setSavedOp(null)

    // Snapshot sourceTemps
    const sourceTemps: Record<string, number> = {}
    for (const s of SOURCES) {
      const v = tomorrowSources.sources[s.key]?.tmax
      if (v !== null && v !== undefined) sourceTemps[s.key] = v
    }

    try {
      const res = await fetch('/api/comparison/save-prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weights,
          optWeights: opt?.weights ?? null,
          ensembleTemp: ensemble,
          sourceTemps,
          targetDate: tomorrowSources.date,
          stake,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)

      setSavedOp({
        predictionId: json.prediction.id,
        targetDate:   json.prediction.target_date,
        ensembleTemp: json.prediction.ensemble_temp,
        tokenA:       json.tokenA,
        tokenB:       json.tokenB,
        stake,
        isUpdate:     json.isUpdate,
      })
    } catch (e: any) {
      setSaveOpError(e.message ?? 'Error desconocido')
    } finally {
      setSavingOp(false)
    }
  }, [tomorrowSources, weights, opt, stake, computeEnsemble])

  // ─── Render ───────────────────────────────────────────────────────────────

  const ensemble = tomorrowSources ? computeEnsemble(tomorrowSources.sources) : null

  return (
    <div className="space-y-6 p-4 sm:p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Comparativa de fuentes</h1>
          <p className="text-gray-400 text-sm mt-1">
            Últimos 8 días · Temperatura máxima Madrid · Polymarket
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="shrink-0 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                     text-white text-sm font-medium transition-colors"
        >
          {loading ? 'Cargando…' : 'Actualizar datos'}
        </button>
      </div>

      {progress && (
        <p className="text-xs text-blue-400 animate-pulse">{progress}</p>
      )}
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ── Pesos del ensemble ─────────────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-300">Pesos del ensemble</h2>
            <p className={`text-xs mt-0.5 ${Math.abs(weightSum - 1) < 0.01 ? 'text-gray-500' : 'text-yellow-400'}`}>
              Suma: {(weightSum * 100).toFixed(0)}% {Math.abs(weightSum - 1) > 0.01 && '— normaliza antes de guardar'}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <button onClick={normalize}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white
                         hover:border-gray-500 transition-colors">
              Normalizar
            </button>
            <button onClick={saveWeightsToSupabase} disabled={savingWeights}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                savedOk
                  ? 'border-green-700 bg-green-950 text-green-400'
                  : 'border-blue-800 bg-blue-950 text-blue-400 hover:bg-blue-900'
              } disabled:opacity-50`}>
              {savingWeights ? 'Guardando…' : savedOk ? '✓ Guardado' : 'Guardar pesos'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {SOURCES.map(s => (
            <div key={s.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">{s.short}</span>
                <span className="text-xs text-white font-medium">{Math.round(weights[s.key] * 100)}%</span>
              </div>
              <input
                type="range" min={0} max={1} step={0.01}
                value={weights[s.key]}
                onChange={e => setWeights(w => ({ ...w, [s.key]: parseFloat(e.target.value) }))}
                className="w-full accent-blue-500"
              />
              {!keysConfigured[s.key] && !s.free && (
                <span className="text-[9px] text-gray-600">sin key</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Tabla comparativa ─────────────────────────────────────────────── */}
      {data && (
        <>
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 overflow-x-auto">
            <h2 className="text-sm font-medium text-gray-300 mb-4">Últimos 8 días</h2>
            <table className="w-full text-xs text-left border-collapse min-w-[640px]">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="py-2 pr-4 text-gray-500 font-medium">Fecha</th>
                  <th className="py-2 pr-4 text-gray-500 font-medium">Polymarket</th>
                  {SOURCES.map(s => (
                    <th key={s.key} className="py-2 pr-4 text-gray-500 font-medium">{s.short}</th>
                  ))}
                  <th className="py-2 text-gray-500 font-medium">Ensemble</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(row => {
                  const ref = row.polymarket.temp
                  const rowEnsemble = (() => {
                    let ws = 0, tw = 0
                    for (const s of SOURCES) {
                      const v = row.sources[s.key]?.tmax
                      if (v !== null && v !== undefined) { ws += v * weights[s.key]; tw += weights[s.key] }
                    }
                    return tw > 0 ? Math.round(ws / tw * 10) / 10 : null
                  })()
                  return (
                    <tr key={row.date} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                      <td className="py-2 pr-4 text-gray-300">{fmtDate(row.date)}</td>
                      <td className="py-2 pr-4">
                        {ref !== null
                          ? <span className="text-white font-medium">{ref}°</span>
                          : <span className="text-gray-600">—</span>
                        }
                      </td>
                      {SOURCES.map(s => {
                        const v = row.sources[s.key]?.tmax
                        const delta = ref !== null && v !== null ? v - ref : null
                        return (
                          <td key={s.key} className="py-2 pr-4">
                            {v !== null ? (
                              <span className="text-gray-300">{v}°
                                {delta !== null && (
                                  <span className={`ml-1 ${errColor(Math.abs(delta))}`}>
                                    {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-gray-700">—</span>
                            )}
                          </td>
                        )
                      })}
                      <td className="py-2">
                        {rowEnsemble !== null
                          ? <span className="text-blue-400 font-medium">{rowEnsemble}°</span>
                          : <span className="text-gray-600">—</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          {/* ── Pesos óptimos propuestos ─────────────────────────────────── */}
          {opt && (
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium text-gray-300">Pesos óptimos propuestos</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Calculados por MAE inverso vs temperatura implícita de Polymarket.
                  </p>
                </div>
                <button onClick={() => applyOptWeights(opt.weights)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-green-950 border border-green-800
                             text-green-400 hover:bg-green-900 transition-colors">
                  Aplicar pesos
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
                {SOURCES.map(s => {
                  const mae = opt.maes[s.key]; const cnt = opt.counts[s.key]
                  const w = opt.weights[s.key]; const curr = weights[s.key]
                  const diff = w !== undefined ? Math.round((w - curr) * 100) : 0
                  return (
                    <div key={s.key} className="bg-gray-950 border border-gray-800 rounded-xl p-3">
                      <p className="text-xs text-gray-500 mb-1">{s.name}</p>
                      <p className="text-2xl font-semibold text-white">
                        {w !== undefined ? Math.round(w * 100) : '—'}
                        {w !== undefined && <span className="text-base">%</span>}
                      </p>
                      {mae !== undefined && (
                        <p className="text-[10px] text-gray-600 mt-1">MAE {mae.toFixed(2)}°C · {cnt}d</p>
                      )}
                      {w !== undefined && diff !== 0 && (
                        <p className={`text-[10px] mt-0.5 ${diff > 0 ? 'text-green-500' : 'text-orange-500'}`}>
                          {diff > 0 ? '↑' : '↓'} {Math.abs(diff)}pp
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}

      {/* ── Predicción para mañana ─────────────────────────────────────────── */}
      {tomorrowSources && (() => {
        return (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-medium text-gray-300">
                  Predicción para mañana
                  <span className="ml-2 text-xs text-gray-500">{fmtDate(tomorrowSources.date)}</span>
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Ensemble con los pesos actuales. Open-Meteo siempre disponible; el resto requiere API key.
                </p>
              </div>
              {ensemble !== null && (
                <div className="text-right shrink-0">
                  <p className="text-3xl font-bold text-blue-400 leading-none">{ensemble}°C</p>
                  <p className="text-xs text-gray-500 mt-1">Tmax estimada</p>
                </div>
              )}
            </div>

            {/* Detalle por fuente */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
              {SOURCES.map(s => {
                const sr = tomorrowSources.sources[s.key]
                const v  = sr?.tmax
                const w  = weights[s.key]
                return (
                  <div key={s.key}
                    className={`rounded-lg px-3 py-2 border text-center ${
                      v !== null ? 'bg-gray-800 border-gray-700' : 'bg-gray-950 border-gray-800 opacity-50'
                    }`}>
                    <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{s.short}</p>
                    {v !== null ? (
                      <>
                        <p className="text-base font-bold text-white mt-0.5">{v}°C</p>
                        <p className="text-[10px] text-gray-500">{Math.round(w * 100)}%</p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-gray-600 mt-1">—</p>
                        <p className="text-[10px] text-gray-700 mt-0.5 truncate" title={sr?.err ?? ''}>
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
                ⚠ Sin datos suficientes para calcular el ensemble.
              </p>
            )}

            {/* ── ⭐ Bloque: Registrar operación ──────────────────────────── */}
            {ensemble !== null && (
              <div className="mt-6 border-t border-gray-800 pt-5">
                <div className="flex flex-col sm:flex-row sm:items-end gap-4">
                  <div className="flex-1">
                    <h3 className="text-sm font-medium text-gray-300 mb-1">Registrar operación simulada</h3>
                    <p className="text-xs text-gray-500">
                      Se comprará <span className="text-white">ceil({ensemble}°) = {Math.ceil(ensemble)}°C</span> y{' '}
                      <span className="text-white">{Math.ceil(ensemble) + 1}°C</span> con{' '}
                      <span className="text-white">{stake / 2} USD cada token</span>.
                      Guarda pesos {opt ? 'óptimos ' : ''}+ predicción + trades en la BBDD.
                    </p>
                  </div>

                  {/* Stake input */}
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="text-xs text-gray-400 whitespace-nowrap">Stake total</label>
                    <div className="relative">
                      <input
                        type="number" min={1} max={1000} step={1}
                        value={stake}
                        onChange={e => setStake(Math.max(1, parseInt(e.target.value) || 20))}
                        className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                                   text-white text-sm text-right focus:outline-none focus:border-blue-600"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">USD</span>
                    </div>
                  </div>

                  {/* Botón registrar */}
                  <button
                    onClick={registerOperation}
                    disabled={savingOp}
                    className="shrink-0 px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500
                               disabled:opacity-50 text-white text-sm font-medium transition-colors
                               flex items-center gap-2"
                  >
                    {savingOp ? (
                      <><span className="animate-spin">⟳</span> Registrando…</>
                    ) : (
                      '⭐ Registrar operación'
                    )}
                  </button>
                </div>

                {/* Error al guardar */}
                {saveOpError && (
                  <div className="mt-3 bg-red-950 border border-red-800 rounded-lg px-4 py-2.5 text-red-400 text-xs">
                    {saveOpError}
                  </div>
                )}

                {/* ── Confirmación de operación guardada ─────────────────── */}
                {savedOp && (
                  <div className="mt-4 bg-violet-950/60 border border-violet-800 rounded-xl p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="text-sm font-medium text-violet-300">
                          {savedOp.isUpdate ? '🔄 Operación actualizada' : '✅ Operación registrada'}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {fmtDate(savedOp.targetDate)} · Predicción ID: {savedOp.predictionId.substring(0, 8)}…
                        </p>
                      </div>
                      <p className="text-lg font-bold text-white shrink-0">
                        {savedOp.ensembleTemp}°C
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {/* Token A */}
                      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500 font-medium uppercase">Token A</span>
                          <span className="text-xs text-violet-400 font-bold">
                            {savedOp.tokenA.temp}°C
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-600 font-mono truncate mb-2">{savedOp.tokenA.slug}</p>
                        <div className="grid grid-cols-3 gap-1 text-center">
                          <div>
                            <p className="text-[9px] text-gray-600">Coste</p>
                            <p className="text-xs font-medium text-white">${savedOp.tokenA.cost}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Precio</p>
                            <p className="text-xs font-medium text-white">
                              {savedOp.tokenA.price !== null
                                ? savedOp.tokenA.price.toFixed(3)
                                : <span className="text-gray-600">N/D</span>
                              }
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Shares</p>
                            <p className="text-xs font-medium text-white">
                              {savedOp.tokenA.shares !== null
                                ? savedOp.tokenA.shares.toFixed(2)
                                : <span className="text-gray-600">N/D</span>
                              }
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Token B */}
                      <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500 font-medium uppercase">Token B</span>
                          <span className="text-xs text-blue-400 font-bold">
                            {savedOp.tokenB.temp}°C
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-600 font-mono truncate mb-2">{savedOp.tokenB.slug}</p>
                        <div className="grid grid-cols-3 gap-1 text-center">
                          <div>
                            <p className="text-[9px] text-gray-600">Coste</p>
                            <p className="text-xs font-medium text-white">${savedOp.tokenB.cost}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Precio</p>
                            <p className="text-xs font-medium text-white">
                              {savedOp.tokenB.price !== null
                                ? savedOp.tokenB.price.toFixed(3)
                                : <span className="text-gray-600">N/D</span>
                              }
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Shares</p>
                            <p className="text-xs font-medium text-white">
                              {savedOp.tokenB.shares !== null
                                ? savedOp.tokenB.shares.toFixed(2)
                                : <span className="text-gray-600">N/D</span>
                              }
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                      <span>
                        Stake total: <span className="text-white font-medium">${savedOp.stake}</span>
                        {' · '}Pesos {opt ? 'óptimos (MAE)' : 'actuales'} guardados en BD
                      </span>
                      <a href="/predictions"
                        className="text-blue-400 hover:text-blue-300 transition-colors">
                        Ver operaciones →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })()}

      {/* API Keys (colapsable) */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl">
        <button
          onClick={() => setShowKeys(k => !k)}
          className="w-full flex items-center justify-between px-5 py-4 text-sm text-gray-400
                     hover:text-white transition-colors">
          <span>Claves API locales (overrides)</span>
          <span>{showKeys ? '▲' : '▼'}</span>
        </button>
        {showKeys && (
          <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {['aemet', 'openweather', 'tomorrow', 'visual_crossing', 'weatherapi', 'accuweather'].map(k => (
              <div key={k}>
                <label className="text-xs text-gray-500 mb-1 block">{k}</label>
                <input
                  type="password"
                  value={keyOverrides[k] ?? ''}
                  onChange={e => setKeyOverrides(o => ({ ...o, [k]: e.target.value }))}
                  placeholder={keysConfigured[k] ? 'Configurada en servidor' : 'Sin key'}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5
                             text-white text-xs focus:outline-none focus:border-blue-600"
                />
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  )
}
