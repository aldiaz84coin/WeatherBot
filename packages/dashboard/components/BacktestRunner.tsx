'use client'
// components/BacktestRunner.tsx
// Panel de control de backtest con actualizaciones en tiempo real.
// Polling cada 3 segundos mientras el job está activo.

import { useState, useEffect, useRef, useCallback } from 'react'
import { format, subDays, subMonths } from 'date-fns'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface BacktestLog {
  id: number
  created_at: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  data?: Record<string, unknown>
}

interface BacktestJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'error'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  config: {
    start_date: string
    end_date: string
    budget: number
    sources: string[]
  }
  result?: {
    hitRate: number
    totalDays: number
    resolvedDays: number
    wins: number
    daysWithMarket: number
    totalProfit: number
    passed: boolean
    rmseBySource: Record<string, number>
    durationSeconds: number
  }
  errorMsg?: string
  trainingRunId?: string
}

interface WeatherSource {
  id: string
  name: string
  slug: string
  weight: number
  rmse_365d: number | null
  active: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const logLevelStyle: Record<string, string> = {
  info:    'text-gray-400',
  warn:    'text-yellow-400',
  error:   'text-red-400',
  success: 'text-green-400',
}

const logLevelPrefix: Record<string, string> = {
  info:    '·',
  warn:    '⚠',
  error:   '✗',
  success: '✓',
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  sources: WeatherSource[]
}

export function BacktestRunner({ sources: initialSources }: Props) {
  const today = new Date()
  const [sources, setSources] = useState<WeatherSource[]>(initialSources)

  // Formulario
  const [startDate, setStartDate] = useState(format(subMonths(today, 3), 'yyyy-MM-dd'))
  const [endDate, setEndDate] = useState(format(subDays(today, 1), 'yyyy-MM-dd'))
  const [budget, setBudget] = useState('0.80')

  // Estado del job
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<BacktestJob | null>(null)
  const [logs, setLogs] = useState<BacktestLog[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const logsEndRef = useRef<HTMLDivElement>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll a los últimos logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Polling del estado del job
  const pollJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/backtest/status/${id}`)
      if (!res.ok) return
      const data = await res.json()
      setJob(data.job)
      setLogs(data.logs ?? [])

      // Parar polling si el job terminó
      if (['done', 'error'].includes(data.job.status)) {
        if (pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = null
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (!jobId) return

    // Polling inmediato + cada 3 segundos
    pollJob(jobId)
    pollingRef.current = setInterval(() => pollJob(jobId), 3000)

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [jobId, pollJob])

  // Lanzar backtest
  const handleRun = async () => {
    setIsCreating(true)
    setError(null)
    setJob(null)
    setLogs([])
    setJobId(null)

    const activeSources = sources.filter(s => s.active).map(s => s.slug)

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          budget: parseFloat(budget),
          sources: activeSources,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Error desconocido')
        return
      }

      setJobId(data.jobId)
    } catch (err) {
      setError('Error de conexión')
    } finally {
      setIsCreating(false)
    }
  }

  // Toggle fuente activa
  const toggleSource = async (slug: string) => {
    const updated = sources.map(s =>
      s.slug === slug ? { ...s, active: !s.active } : s
    )
    setSources(updated)

    // Guardar en Supabase
    const source = updated.find(s => s.slug === slug)
    if (source) {
      await fetch('/api/sources', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ slug, active: source.active }] }),
      })
    }
  }

  const isActive = job && ['pending', 'running'].includes(job.status)
  const isDone = job?.status === 'done'
  const isError = job?.status === 'error'

  // Calcular días en el rango
  const daysInRange = Math.round(
    (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
  )

  return (
    <div className="space-y-6">

      {/* ── Configuración de fuentes ───────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-300 mb-4">
          Fuentes meteorológicas
          <span className="ml-2 text-xs text-gray-600">
            {sources.filter(s => s.active).length}/{sources.length} activas
          </span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {sources.map(src => (
            <label
              key={src.slug}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                src.active
                  ? 'border-blue-800 bg-blue-950/30'
                  : 'border-gray-800 bg-gray-950 opacity-60'
              }`}
            >
              <input
                type="checkbox"
                checked={src.active}
                onChange={() => toggleSource(src.slug)}
                className="w-4 h-4 rounded accent-blue-500"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{src.name}</p>
                <p className="text-xs text-gray-500">
                  {src.rmse_365d != null
                    ? `RMSE ${src.rmse_365d.toFixed(2)}°C`
                    : 'RMSE pendiente'}
                  {' · '}
                  peso {(src.weight * 100).toFixed(0)}%
                </p>
              </div>
              {src.active && (
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              )}
            </label>
          ))}
        </div>
      </section>

      {/* ── Parámetros del backtest ────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-gray-300 mb-4">Parámetros del backtest</h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          {/* Fecha inicio */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Fecha inicio</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              disabled={!!isActive}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-blue-600 disabled:opacity-50"
            />
          </div>

          {/* Fecha fin */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Fecha fin</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              disabled={!!isActive}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-blue-600 disabled:opacity-50"
            />
          </div>

          {/* Budget */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">
              Budget máximo (USDC/día)
            </label>
            <input
              type="number"
              value={budget}
              step="0.05"
              min="0.10"
              max="0.99"
              onChange={e => setBudget(e.target.value)}
              disabled={!!isActive}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-blue-600 disabled:opacity-50"
            />
          </div>
        </div>

        {/* Resumen del rango */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs text-gray-500">
            {daysInRange} días · {sources.filter(s => s.active).length} fuentes activas ·
            ganancia mínima si gana: {(1 - parseFloat(budget || '0')).toFixed(2)} USDC
          </p>
          <div className="flex gap-2">
            {[
              { label: '1 mes', days: 30 },
              { label: '3 meses', days: 90 },
              { label: '6 meses', days: 180 },
              { label: '1 año', days: 365 },
            ].map(({ label, days }) => (
              <button
                key={days}
                onClick={() => setStartDate(format(subDays(today, days), 'yyyy-MM-dd'))}
                disabled={!!isActive}
                className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 
                           hover:text-white transition-colors disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-950 border border-red-800 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Botón lanzar */}
        <button
          onClick={handleRun}
          disabled={!!isActive || isCreating || sources.filter(s => s.active).length === 0}
          className={`w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-all ${
            isActive || isCreating
              ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
          }`}
        >
          {isCreating
            ? 'Creando job...'
            : isActive
              ? `Ejecutando... (${job?.status})`
              : '▶ Lanzar backtest'}
        </button>
      </section>

      {/* ── Monitor de progreso ────────────────────────────────────────── */}
      {jobId && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-300">
              Progreso del backtest
              {isActive && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  En ejecución
                </span>
              )}
            </h2>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              job?.status === 'done' && job.result?.passed
                ? 'bg-green-950 text-green-400 border border-green-800'
                : job?.status === 'done'
                  ? 'bg-red-950 text-red-400 border border-red-800'
                  : job?.status === 'error'
                    ? 'bg-red-950 text-red-400 border border-red-800'
                    : job?.status === 'running'
                      ? 'bg-blue-950 text-blue-400 border border-blue-800'
                      : 'bg-gray-800 text-gray-400 border border-gray-700'
            }`}>
              {job?.status === 'done' && job.result?.passed ? '✅ Objetivo superado'
                : job?.status === 'done' ? '❌ Objetivo no alcanzado'
                : job?.status === 'error' ? '⚠ Error'
                : job?.status === 'running' ? '⏳ Ejecutando'
                : '⏸ En cola'}
            </span>
          </div>

          {/* Resultado final */}
          {isDone && job.result && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 p-3 bg-gray-950 rounded-lg">
              <div>
                <p className="text-xs text-gray-500">Hit rate</p>
                <p className={`text-xl font-bold mt-0.5 ${
                  job.result.passed ? 'text-green-400' : 'text-red-400'
                }`}>
                  {(job.result.hitRate * 100).toFixed(1)}%
                </p>
                <p className="text-xs text-gray-600">objetivo ≥ 90%</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Días con mercado</p>
                <p className="text-xl font-bold text-white mt-0.5">{job.result.daysWithMarket}</p>
                <p className="text-xs text-gray-600">de {job.result.totalDays} totales</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Aciertos</p>
                <p className="text-xl font-bold text-white mt-0.5">
                  {job.result.wins}/{job.result.resolvedDays}
                </p>
                <p className="text-xs text-gray-600">días resueltos</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Profit total sim.</p>
                <p className={`text-xl font-bold mt-0.5 ${
                  job.result.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {job.result.totalProfit >= 0 ? '+' : ''}{job.result.totalProfit} USDC
                </p>
                <p className="text-xs text-gray-600">
                  {job.result.durationSeconds
                    ? `en ${formatDuration(job.result.durationSeconds)}`
                    : ''}
                </p>
              </div>
            </div>
          )}

          {/* Error message */}
          {isError && job.errorMsg && (
            <div className="mb-4 p-3 rounded-lg bg-red-950 border border-red-800 text-red-400 text-sm">
              {job.errorMsg}
            </div>
          )}

          {/* Terminal de logs */}
          <div className="bg-gray-950 rounded-lg border border-gray-800 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <span className="text-xs text-gray-500 ml-1">backtest.log</span>
              <span className="ml-auto text-xs text-gray-600">{logs.length} entradas</span>
            </div>
            <div className="p-3 font-mono text-xs space-y-0.5 max-h-72 overflow-y-auto">
              {logs.length === 0 ? (
                <p className="text-gray-600 py-2">
                  {isActive ? 'Esperando logs...' : 'Sin logs disponibles'}
                </p>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="flex gap-2">
                    <span className="text-gray-700 flex-shrink-0">
                      {new Date(log.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span className={`flex-shrink-0 ${logLevelStyle[log.level]}`}>
                      {logLevelPrefix[log.level]}
                    </span>
                    <span className={logLevelStyle[log.level]}>
                      {log.message}
                    </span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </section>
      )}

    </div>
  )
}
