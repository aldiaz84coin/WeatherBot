'use client'
// packages/dashboard/components/AIOptimizer.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Panel del Optimizador IA.
// Consulta /api/ai-optimizer, muestra:
//   • Hit rate histórico + ciclos analizados
//   • Pesos recomendados por fuente (vs pesos actuales)
//   • Bias óptimo + propuesta de tokens para mañana
//   • Distribución de hit rate por bias
//   • Insights / warnings del modelo
// ──────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react'
import type { AIOptimizerResult } from '../types/ai-optimizer'

// ─── Helpers de estilo ────────────────────────────────────────────────────────

const pct = (n: number) => `${Math.round(n * 100)}%`
const flt = (n: number, d = 3) => n.toFixed(d)
const sign = (n: number) => (n >= 0 ? '+' : '') + flt(n, 1)

function hitRateColor(rate: number) {
  if (rate >= 70) return 'text-green-400'
  if (rate >= 55) return 'text-yellow-400'
  return 'text-red-400'
}

function maeDot(mae: number) {
  if (mae < 1)   return 'bg-green-500'
  if (mae < 1.5) return 'bg-yellow-500'
  return 'bg-red-500'
}

// ─── Subcomponente: barra de bias ─────────────────────────────────────────────

function BiasBar({
  bias, hitRate, isOptimal, current,
}: {
  bias: number; hitRate: number; isOptimal: boolean; current: boolean
}) {
  const width = `${Math.max(4, hitRate)}%`
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-10 text-right tabular-nums ${isOptimal ? 'text-blue-300 font-semibold' : 'text-gray-500'}`}>
        {sign(bias)}°C
      </span>
      <div className="flex-1 bg-gray-800 rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOptimal ? 'bg-blue-500' : current ? 'bg-yellow-600' : 'bg-gray-600'
          }`}
          style={{ width }}
        />
      </div>
      <span className={`w-12 tabular-nums ${hitRateColor(hitRate)}`}>
        {hitRate.toFixed(1)}%
      </span>
      {isOptimal && <span className="text-blue-400 text-[10px]">✦ óptimo</span>}
      {current && !isOptimal && <span className="text-yellow-600 text-[10px]">actual</span>}
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function AIOptimizer() {
  const [result,   setResult]   = useState<AIOptimizerResult | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [mode,     setMode]     = useState<'full' | 'weights' | 'bias'>('full')
  const [lookback, setLookback] = useState(60)
  const [applying, setApplying] = useState(false)
  const [applied,  setApplied]  = useState<string | null>(null)

  // ── Cargar último resultado cacheado al montar ──────────────────────────
  const loadCached = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-optimizer')
      const json = await res.json()
      if (json.cached) setResult(json.cached as AIOptimizerResult)
    } catch { /* silencioso */ }
  }, [])

  // Llamar loadCached una sola vez al renderizar
  useState(() => { loadCached() })

  // ── Ejecutar optimización ────────────────────────────────────────────────
  const runOptimizer = useCallback(async () => {
    setLoading(true); setError(null); setApplied(null)
    try {
      const res = await fetch('/api/ai-optimizer', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode, lookbackDays: lookback }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setResult(json as AIOptimizerResult)
    } catch (e: any) {
      setError(e.message ?? 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [mode, lookback])

  // ── Aplicar pesos recomendados → /api/sources (PATCH) ───────────────────
  const applyWeights = useCallback(async () => {
    if (!result?.weightRecommendations.weights) return
    setApplying(true)
    try {
      const slugMap: Record<string, string> = {
        open_meteo:      'open-meteo',
        aemet:           'aemet',
        visual_crossing: 'visual-crossing',
        weatherapi:      'weatherapi',
        openweather:     'openweathermap',
        tomorrow:        'tomorrow-io',
        accuweather:     'accuweather',
      }
      const sourcesUpdate = Object.entries(result.weightRecommendations.weights)
        .map(([key, weight]) => ({ slug: slugMap[key] ?? key, weight }))

      const res = await fetch('/api/sources', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sources: sourcesUpdate }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setApplied('weights')
    } catch (e: any) {
      setError(`Error aplicando pesos: ${e.message}`)
    } finally {
      setApplying(false)
    }
  }, [result])

  // ── Aplicar bias recomendado ─────────────────────────────────────────────
  const applyBias = useCallback(async () => {
    if (result?.bettingRecommendations.optimalBias == null) return
    setApplying(true)
    try {
      const res = await fetch('/api/ai-optimizer/apply-bias', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ bias: result.bettingRecommendations.optimalBias }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setApplied('bias')
    } catch (e: any) {
      setError(`Error aplicando bias: ${e.message}`)
    } finally {
      setApplying(false)
    }
  }, [result])

  const w  = result?.weightRecommendations
  const b  = result?.bettingRecommendations
  const bd = b?.biasDistribution ?? []
  const optimalBias = b?.optimalBias ?? 0

  return (
    <div className="space-y-4">

      {/* ── Header + controles ─────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              🤖 Optimizador IA
            </h2>
            <p className="text-gray-500 text-xs mt-0.5">
              Usa Claude para recalibrar pesos de fuentes y offset de apuesta
            </p>
          </div>

          {/* Controles */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Modo */}
            <select
              value={mode}
              onChange={e => setMode(e.target.value as any)}
              className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-2"
            >
              <option value="full">Análisis completo</option>
              <option value="weights">Solo pesos</option>
              <option value="bias">Solo bias/apuesta</option>
            </select>

            {/* Lookback */}
            <select
              value={lookback}
              onChange={e => setLookback(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-2"
            >
              <option value={20}>Últimos 20 días</option>
              <option value={30}>Últimos 30 días</option>
              <option value={60}>Últimos 60 días</option>
              <option value={90}>Últimos 90 días</option>
            </select>

            {/* Botón ejecutar */}
            <button
              onClick={runOptimizer}
              disabled={loading}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                         text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {loading ? (
                <>
                  <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Analizando…
                </>
              ) : (
                <>✦ Optimizar</>
              )}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-red-400 text-xs bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* ── Sin resultados todavía ─────────────────────────────────────── */}
      {!result && !loading && (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-8 text-center">
          <p className="text-gray-600 text-sm">
            Pulsa <strong className="text-gray-400">✦ Optimizar</strong> para que la IA analice
            el historial y proponga ajustes.
          </p>
        </div>
      )}

      {/* ── Resultados ────────────────────────────────────────────────── */}
      {result && (
        <>
          {/* KPIs globales */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Ciclos analizados', value: result.cyclesAnalyzed },
              { label: 'Hit rate histórico', value: `${result.hitRate}%`,
                cls: hitRateColor(result.hitRate) },
              { label: 'Generado', value: new Date(result.generatedAt)
                .toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) },
            ].map(k => (
              <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-600 mb-1">{k.label}</p>
                <p className={`text-lg font-mono font-semibold ${(k as any).cls ?? 'text-white'}`}>
                  {k.value}
                </p>
              </div>
            ))}
          </div>

          {/* ── Sección 1: Pesos ──────────────────────────────────────── */}
          {w && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-medium text-sm">
                  📊 Pesos recomendados por fuente
                </h3>
                <div className="flex items-center gap-2">
                  {w.improvedVsPrev !== null && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      w.improvedVsPrev > 0
                        ? 'bg-green-950 text-green-400'
                        : 'bg-red-950 text-red-400'
                    }`}>
                      {w.improvedVsPrev > 0 ? '↓' : '↑'} MAE {Math.abs(w.improvedVsPrev).toFixed(3)}°C
                    </span>
                  )}
                  <button
                    onClick={applyWeights}
                    disabled={applying}
                    className="text-xs bg-green-800 hover:bg-green-700 text-green-100
                               px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {applied === 'weights' ? '✓ Aplicados' : 'Aplicar pesos'}
                  </button>
                </div>
              </div>

              {/* Tabla de pesos */}
              <div className="space-y-1.5">
                {Object.entries(w.weights)
                  .sort(([, a], [, b]) => b - a)
                  .map(([src, weight]) => {
                    const stat = w.sourceStats[src]
                    return (
                      <div key={src} className="flex items-center gap-3 text-xs">
                        <span className="w-24 text-gray-400 truncate">{src}</span>
                        <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: pct(weight) }}
                          />
                        </div>
                        <span className="w-10 text-right text-white font-mono tabular-nums">
                          {Math.round(weight * 100)}%
                        </span>
                        {stat && (
                          <span className="flex items-center gap-1 w-28 text-gray-500">
                            <span className={`w-1.5 h-1.5 rounded-full ${maeDot(stat.mae)}`} />
                            MAE {flt(stat.mae, 2)}°C
                          </span>
                        )}
                      </div>
                    )
                  })}
              </div>

              {/* MAE esperado */}
              <div className="flex items-center gap-2 pt-1 border-t border-gray-800">
                <span className="text-gray-500 text-xs">MAE esperado con nuevos pesos:</span>
                <span className="text-blue-300 text-xs font-mono">{flt(w.expectedMAE, 3)}°C</span>
              </div>

              {/* Rationale */}
              <p className="text-gray-500 text-xs leading-relaxed italic">
                {w.rationale}
              </p>
            </div>
          )}

          {/* ── Sección 2: Bias + propuesta apuesta ──────────────────── */}
          {b && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-medium text-sm">
                  🎯 Bias óptimo y propuesta de apuesta
                </h3>
                <button
                  onClick={applyBias}
                  disabled={applying}
                  className="text-xs bg-purple-800 hover:bg-purple-700 text-purple-100
                             px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                >
                  {applied === 'bias' ? '✓ Aplicado' : 'Aplicar bias'}
                </button>
              </div>

              {/* KPIs bias */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-800/60 rounded-xl p-3">
                  <p className="text-xs text-gray-600">Bias óptimo (N)</p>
                  <p className="text-xl font-mono font-semibold text-blue-300">
                    {sign(b.optimalBias)}°C
                  </p>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-3">
                  <p className="text-xs text-gray-600">Hit rate esperado</p>
                  <p className={`text-xl font-mono font-semibold ${hitRateColor(b.expectedHitRate)}`}>
                    {b.expectedHitRate.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-gray-800/60 rounded-xl p-3">
                  <p className="text-xs text-gray-600">Tokens mañana</p>
                  {b.proposedTokenA ? (
                    <p className="text-xl font-mono font-semibold text-green-300">
                      {b.proposedTokenA}° / {b.proposedTokenB}°
                    </p>
                  ) : (
                    <p className="text-gray-600 text-sm">—</p>
                  )}
                </div>
              </div>

              {/* Distribución de hit rate por bias */}
              {bd.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-gray-600 mb-2">Simulación de hit rate por valor de bias:</p>
                  {bd.map(row => (
                    <BiasBar
                      key={row.bias}
                      bias={row.bias}
                      hitRate={row.hitRate}
                      isOptimal={row.bias === b.optimalBias}
                      current={false}
                    />
                  ))}
                </div>
              )}

              {/* Rationale */}
              <p className="text-gray-500 text-xs leading-relaxed italic">
                {b.rationale}
              </p>
            </div>
          )}

          {/* ── Insights y warnings ──────────────────────────────────── */}
          {((result.insights?.length ?? 0) > 0 || (result.warnings?.length ?? 0) > 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {result.insights?.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <h4 className="text-xs font-medium text-gray-400 mb-2">💡 Insights</h4>
                  <ul className="space-y-1.5">
                    {result.insights.map((ins, i) => (
                      <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                        <span className="text-blue-600 mt-0.5">•</span>
                        {ins}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.warnings?.length > 0 && (
                <div className="bg-gray-900 border border-yellow-900/40 rounded-xl p-4">
                  <h4 className="text-xs font-medium text-yellow-600 mb-2">⚠️ Avisos</h4>
                  <ul className="space-y-1.5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-xs text-yellow-700 flex gap-1.5">
                        <span className="mt-0.5">•</span>
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
