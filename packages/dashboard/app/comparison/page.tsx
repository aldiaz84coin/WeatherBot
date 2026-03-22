'use client'

// packages/dashboard/app/comparison/page.tsx
// Comparativa de fuentes + ⭐ pesos óptimos calculados sobre histórico completo

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
  historicalSaved?: number
}

interface HistoricalStats {
  totalDays: number
  earliestDate: string | null
  latestDate: string | null
  maes: Record<string, number>
  counts: Record<string, number>
  optimalWeights: Record<string, number> | null
  recent: Array<Record<string, number | string | null>>
  message?: string
}

interface SavedOperation {
  predictionId: string
  targetDate: string
  ensembleTemp: number
  tokenA: { temp: number; slug: string; price: number | null; shares: number | null; cost: number }
  tokenB: { temp: number; slug: string; price: number | null; shares: number | null; cost: number }
  stake: number
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
  const today = new Date()
  const [sources]         = useState(SOURCES)
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

  // ── Histórico ────────────────────────────────────────────────────────────────
  const [historical,     setHistorical]     = useState<HistoricalStats | null>(null)
  const [historicalLoading, setHistoricalLoading] = useState(false)
  const [showHistoricalTable, setShowHistoricalTable] = useState(false)
  const [lastSaved,      setLastSaved]      = useState<number | null>(null)

  // ── Operación ────────────────────────────────────────────────────────────────
  const [stake,    setStake]    = useState(20)
  const [savingOp, setSavingOp] = useState(false)
  const [savedOp,  setSavedOp]  = useState<SavedOperation | null>(null)
  const [saveOpError, setSaveOpError] = useState<string | null>(null)

  // ── Cargar pesos desde BD y estadísticas históricas al montar ────────────────
  useEffect(() => {
    // Pesos actuales de Supabase
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

    // Estadísticas históricas — cargar siempre al montar
    loadHistoricalStats()
  }, [loadHistoricalStats])

  const loadHistoricalStats = useCallback(async () => {
    setHistoricalLoading(true)
    try {
      const res = await fetch('/api/historical')
      if (res.ok) {
        const d: HistoricalStats = await res.json()
        setHistorical(d)
      }
    } catch {}
    finally { setHistoricalLoading(false) }
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
    setLoading(true); setError(null); setSavedOp(null); setLastSaved(null)
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

      // Mostrar cuántos registros se guardaron
      if (json.historicalSaved !== undefined && json.historicalSaved > 0) {
        setLastSaved(json.historicalSaved)
      }
      // Refrescar stats históricas siempre (aunque no haya nuevos registros)
      await loadHistoricalStats()
      setProgress('')
    } catch (e: any) {
      setError(e.message ?? 'Error desconocido'); setProgress('')
    } finally {
      setLoading(false)
    }
  }, [keyOverrides, loadHistoricalStats])

  const applyOptWeights = useCallback((optW: Record<SourceKey, number>) => {
    setWeights({ ...optW })
  }, [])

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

  const computeEnsemble = useCallback((srcs: TomorrowSources['sources']): number | null => {
    let ws = 0, tw = 0
    for (const s of SOURCES) {
      const v = srcs[s.key]?.tmax
      if (v !== null && v !== undefined) { ws += v * weights[s.key]; tw += weights[s.key] }
    }
    return tw > 0 ? Math.round((ws / tw) * 10) / 10 : null
  }, [weights])

  // ── Pesos óptimos desde los últimos 8 días (ventana corta) ───────────────────
  const opt = data ? (() => {
    const maes: Partial<Record<SourceKey, number>> = {}
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

  // ── Registrar operación ───────────────────────────────────────────────────────
  const registerOperation = useCallback(async () => {
    if (!tomorrowSources) return
    const ensemble = computeEnsemble(tomorrowSources.sources)
    if (ensemble === null) { setSaveOpError('Sin datos suficientes.'); return }

    setSavingOp(true); setSaveOpError(null); setSavedOp(null)

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
          weights, optWeights: opt?.weights ?? null,
          ensembleTemp: ensemble, sourceTemps,
          targetDate: tomorrowSources.date, stake,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setSavedOp({
        predictionId: json.prediction.id, targetDate: json.prediction.target_date,
        ensembleTemp: json.prediction.ensemble_temp,
        tokenA: json.tokenA, tokenB: json.tokenB,
        stake, isUpdate: json.isUpdate,
      })
    } catch (e: any) {
      setSaveOpError(e.message ?? 'Error desconocido')
    } finally {
      setSavingOp(false)
    }
  }, [tomorrowSources, weights, opt, stake, computeEnsemble])

  const ensemble = tomorrowSources ? computeEnsemble(tomorrowSources.sources) : null

  // ── Render ────────────────────────────────────────────────────────────────────

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

      {progress && <p className="text-xs text-blue-400 animate-pulse">{progress}</p>}
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ⭐ Bloque histórico ──────────────────────────────────────────────────── */}
      <section className={`border rounded-xl p-5 ${
        historical && historical.totalDays > 0
          ? 'bg-gray-900 border-blue-900/60'
          : 'bg-gray-900 border-gray-800'
      }`}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-medium text-gray-200 flex items-center gap-2">
              📊 Histórico acumulado
              {historicalLoading && (
                <span className="text-xs text-gray-500 animate-pulse">cargando…</span>
              )}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Cada vez que pulsas "Actualizar datos", los días resueltos de Polymarket se guardan
              automáticamente. Con suficientes registros, los pesos óptimos son mucho más robustos
              que con la ventana de 8 días.
            </p>
          </div>
          <button
            onClick={loadHistoricalStats}
            disabled={historicalLoading}
            className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400
                       hover:text-white hover:border-gray-500 transition-colors disabled:opacity-50"
          >
            ↺ Refrescar
          </button>
        </div>

        {!historical || historical.totalDays === 0 ? (
          <div className="bg-gray-950 border border-dashed border-gray-700 rounded-lg px-4 py-6 text-center">
            <p className="text-gray-500 text-sm">
              {historical?.message ?? 'Sin registros todavía.'}
            </p>
            <p className="text-gray-600 text-xs mt-1">
              Pulsa "Actualizar datos" para empezar a acumular histórico.
            </p>
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-500">Días guardados</p>
                <p className="text-2xl font-bold text-blue-400 mt-0.5">{historical.totalDays}</p>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-500">Primer registro</p>
                <p className="text-sm font-medium text-white mt-0.5">
                  {historical.earliestDate ?? '—'}
                </p>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-500">Último registro</p>
                <p className="text-sm font-medium text-white mt-0.5">
                  {historical.latestDate ?? '—'}
                </p>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-500">Último guardado</p>
                <p className="text-sm font-medium mt-0.5">
                  {lastSaved !== null
                    ? <span className="text-green-400">+{lastSaved} registro{lastSaved !== 1 ? 's' : ''}</span>
                    : <span className="text-gray-600">—</span>
                  }
                </p>
              </div>
            </div>

            {/* Pesos óptimos históricos */}
            {historical.optimalWeights && (
              <div className="bg-gray-950 border border-blue-900/40 rounded-xl p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-medium text-blue-300">
                      Pesos óptimos · {historical.totalDays} días de histórico
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      MAE inverso calculado sobre todos los registros acumulados en la BD.
                      {historical.totalDays >= 30
                        ? ' Con más de 30 días, estos pesos son estadísticamente significativos.'
                        : ` Necesitas al menos 30 días para mayor robustez (faltan ${30 - historical.totalDays}).`}
                    </p>
                  </div>
                  <button
                    onClick={() => applyOptWeights(historical.optimalWeights as Record<SourceKey, number>)}
                    className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-blue-900/60 border border-blue-700
                               text-blue-300 hover:bg-blue-800/60 transition-colors"
                  >
                    Aplicar
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {SOURCES.map(s => {
                    const w    = historical.optimalWeights![s.key] ?? 0
                    const mae  = historical.maes[s.key]
                    const cnt  = historical.counts[s.key] ?? 0
                    const curr = weights[s.key]
                    const diff = Math.round((w - curr) * 100)

                    return (
                      <div key={s.key} className="bg-gray-900 rounded-lg p-2.5 border border-gray-800 text-center">
                        <p className="text-[10px] text-gray-500 mb-0.5">{s.short}</p>
                        <p className="text-lg font-bold text-white">{Math.round(w * 100)}%</p>
                        {mae !== undefined && (
                          <p className="text-[9px] text-gray-600 mt-0.5">MAE {mae.toFixed(2)}° · {cnt}d</p>
                        )}
                        {diff !== 0 && (
                          <p className={`text-[9px] mt-0.5 ${diff > 0 ? 'text-green-500' : 'text-orange-500'}`}>
                            {diff > 0 ? '↑' : '↓'}{Math.abs(diff)}pp
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Tabla de últimos registros (colapsable) */}
            {historical.recent && historical.recent.length > 0 && (
              <div>
                <button
                  onClick={() => setShowHistoricalTable(v => !v)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showHistoricalTable ? '▲ Ocultar' : '▼ Ver'} últimos {historical.recent.length} registros
                </button>

                {showHistoricalTable && (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-xs" style={{ minWidth: 700 }}>
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left pb-2 pr-3 text-gray-500 font-normal">Fecha</th>
                          <th className="text-right pb-2 pr-3 text-yellow-600 font-normal">Polymarket</th>
                          {SOURCES.map(s => (
                            <th key={s.key} className="text-right pb-2 pr-3 text-gray-500 font-normal">
                              {s.short}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {historical.recent.map((row: any) => (
                          <tr key={row.date} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                            <td className="py-1.5 pr-3 text-gray-400">{row.date}</td>
                            <td className="py-1.5 pr-3 text-right font-medium text-yellow-400">
                              {row.polymarket_temp}°C
                            </td>
                            {[
                              ['open_meteo', 'open_meteo_tmax'],
                              ['aemet', 'aemet_tmax'],
                              ['visual_crossing', 'visual_crossing_tmax'],
                              ['weatherapi', 'weatherapi_tmax'],
                              ['openweather', 'openweather_tmax'],
                              ['tomorrow', 'tomorrow_tmax'],
                              ['accuweather', 'accuweather_tmax'],
                            ].map(([key, col]) => {
                              const v = row[col]
                              const delta = v != null && row.polymarket_temp != null
                                ? parseFloat((v - row.polymarket_temp).toFixed(1))
                                : null
                              return (
                                <td key={key} className="py-1.5 pr-3 text-right">
                                  {v != null ? (
                                    <span className={delta !== null ? errColor(Math.abs(delta)) : 'text-gray-300'}>
                                      {v}°
                                      {delta !== null && (
                                        <span className="ml-0.5 text-[9px]">
                                          {delta > 0 ? '+' : ''}{delta}
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span className="text-gray-700">—</span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Pesos del ensemble ─────────────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-300">Pesos del ensemble</h2>
            <p className={`text-xs mt-0.5 ${Math.abs(weightSum - 1) < 0.01 ? 'text-gray-500' : 'text-yellow-400'}`}>
              Suma: {(weightSum * 100).toFixed(0)}%{' '}
              {Math.abs(weightSum - 1) > 0.01 && '— normaliza antes de guardar'}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <button onClick={normalize}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400
                         hover:text-white hover:border-gray-500 transition-colors">
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
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-gray-300">Últimos 8 días</h2>
              {data.historicalSaved !== undefined && data.historicalSaved > 0 && (
                <span className="text-xs text-green-400 bg-green-950 border border-green-800 px-2 py-0.5 rounded-full">
                  +{data.historicalSaved} guardado{data.historicalSaved !== 1 ? 's' : ''} en histórico
                </span>
              )}
            </div>
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
                      <td className="py-2 pr-4 text-gray-300">
                        {fmtDate(row.date)}
                        {row.polymarket.resolved && (
                          <span className="ml-1 text-[9px] text-green-600">✓</span>
                        )}
                      </td>
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

          {/* ── Pesos óptimos (ventana 8 días) ─────────────────────────── */}
          {opt && (
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium text-gray-300">
                    Pesos óptimos · últimos 8 días
                    <span className="ml-2 text-xs text-gray-600 font-normal">ventana corta</span>
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    MAE inverso vs temperatura implícita de Polymarket (solo 8 días — usa el histórico para mayor robustez).
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
      {tomorrowSources && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-medium text-gray-300">
                Predicción para mañana
                <span className="ml-2 text-xs text-gray-500">{fmtDate(tomorrowSources.date)}</span>
              </h2>
            </div>
            {ensemble !== null && (
              <div className="text-right shrink-0">
                <p className="text-3xl font-bold text-blue-400 leading-none">{ensemble}°C</p>
                <p className="text-xs text-gray-500 mt-1">Tmax estimada</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
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

          {/* Registrar operación */}
          {ensemble !== null && (
            <div className="mt-6 border-t border-gray-800 pt-5">
              <div className="flex flex-col sm:flex-row sm:items-end gap-4">
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-gray-300 mb-1">Registrar operación simulada</h3>
                  <p className="text-xs text-gray-500">
                    Tokens: <span className="text-white">{Math.ceil(ensemble)}°C</span> y{' '}
                    <span className="text-white">{Math.ceil(ensemble) + 1}°C</span> ·{' '}
                    <span className="text-white">{stake / 2} USD cada uno</span>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-xs text-gray-400 whitespace-nowrap">Stake total</label>
                  <div className="relative">
                    <input
                      type="number" min={1} max={1000} step={1} value={stake}
                      onChange={e => setStake(Math.max(1, parseInt(e.target.value) || 20))}
                      className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                                 text-white text-sm text-right focus:outline-none focus:border-blue-600"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">
                      USD
                    </span>
                  </div>
                </div>
                <button
                  onClick={registerOperation}
                  disabled={savingOp}
                  className="shrink-0 px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500
                             disabled:opacity-50 text-white text-sm font-medium transition-colors"
                >
                  {savingOp ? '⟳ Registrando…' : '⭐ Registrar operación'}
                </button>
              </div>
              {saveOpError && (
                <div className="mt-3 bg-red-950 border border-red-800 rounded-lg px-4 py-2.5 text-red-400 text-xs">
                  {saveOpError}
                </div>
              )}
              {savedOp && (
                <div className="mt-4 bg-violet-950/60 border border-violet-800 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-sm font-medium text-violet-300">
                        {savedOp.isUpdate ? '🔄 Operación actualizada' : '✅ Operación registrada'}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {fmtDate(savedOp.targetDate)} · ID: {savedOp.predictionId.substring(0, 8)}…
                      </p>
                    </div>
                    <p className="text-lg font-bold text-white shrink-0">{savedOp.ensembleTemp}°C</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: 'Token A', token: savedOp.tokenA, color: 'text-violet-400' },
                      { label: 'Token B', token: savedOp.tokenB, color: 'text-blue-400' },
                    ].map(({ label, token, color }) => (
                      <div key={label} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500 font-medium uppercase">{label}</span>
                          <span className={`text-xs font-bold ${color}`}>{token.temp}°C</span>
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-center mt-2">
                          <div>
                            <p className="text-[9px] text-gray-600">Coste</p>
                            <p className="text-xs font-medium text-white">${token.cost}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Precio</p>
                            <p className="text-xs font-medium text-white">
                              {token.price !== null ? token.price.toFixed(3) : <span className="text-gray-600">N/D</span>}
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] text-gray-600">Shares</p>
                            <p className="text-xs font-medium text-white">
                              {token.shares !== null ? token.shares.toFixed(2) : <span className="text-gray-600">N/D</span>}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                    <span>Stake total: <span className="text-white font-medium">${savedOp.stake}</span></span>
                    <a href="/predictions" className="text-blue-400 hover:text-blue-300 transition-colors">
                      Ver operaciones →
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

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
