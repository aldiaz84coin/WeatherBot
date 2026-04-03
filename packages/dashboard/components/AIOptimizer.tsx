// packages/dashboard/components/AIOptimizer.tsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import type { AIOptimizerResult } from '../types/ai-optimizer'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sign  = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1)
const flt   = (v: number, d = 2) => v.toFixed(d)
const pct   = (v: number) => `${Math.round(v * 100)}%`

function maeDot(mae: number) {
  if (mae < 0.5) return 'bg-green-500'
  if (mae < 1.0) return 'bg-yellow-500'
  return 'bg-red-500'
}

function hitRateColor(hr: number) {
  if (hr >= 70) return 'text-green-400'
  if (hr >= 50) return 'text-yellow-400'
  return 'text-red-400'
}

// ─── BiasBar ─────────────────────────────────────────────────────────────────

function BiasBar({
  bias, hitRate, isOptimal, current,
}: { bias: number; hitRate: number; isOptimal: boolean; current: boolean }) {
  const max   = 100
  const width = `${Math.min((hitRate / max) * 100, 100)}%`
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-10 tabular-nums text-right ${
        isOptimal ? 'text-blue-300 font-semibold' : 'text-gray-500'}`}>
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
  // Detalle de lo aplicado para feedback visual
  const [applyDetail, setApplyDetail] = useState<string | null>(null)

  // ── Cargar último resultado cacheado al montar ──────────────────────────────
  const loadCached = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-optimizer')
      if (!res.ok) return
      const text = await res.text()
      if (!text) return
      const json = JSON.parse(text)
      if (json.cached) setResult(json.cached as AIOptimizerResult)
    } catch {
      // silencioso — no hay caché todavía
    }
  }, [])

  useEffect(() => {
    loadCached()
  }, [loadCached])

  // ── Ejecutar optimización ────────────────────────────────────────────────────
  const runOptimizer = useCallback(async () => {
    setLoading(true); setError(null); setApplied(null); setApplyDetail(null)
    try {
      const res = await fetch('/api/ai-optimizer', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode, lookbackDays: lookback }),
      })
      const text = await res.text()
      if (!text) throw new Error('Respuesta vacía del servidor')
      const json = JSON.parse(text)
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setResult(json as AIOptimizerResult)
    } catch (e: any) {
      setError(e.message ?? 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [mode, lookback])

  // ── Aplicar pesos recomendados → /api/sources (PATCH) ──────────────────────
  const applyWeights = useCallback(async () => {
    if (!result?.weightRecommendations.weights) return
    setApplying(true); setError(null); setApplyDetail(null)
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const summary = sourcesUpdate
        .sort((a, b) => b.weight - a.weight)
        .map(s => `${s.slug} ${Math.round(s.weight * 100)}%`)
        .join(' · ')
      setApplied('weights')
      setApplyDetail(`✓ Pesos guardados en Supabase — efectivos en el próximo ciclo (00:30)\n${summary}`)
    } catch (e: any) {
      setError(`Error aplicando pesos: ${e.message}`)
    } finally {
      setApplying(false)
    }
  }, [result])

  // ── Aplicar bias recomendado ─────────────────────────────────────────────────
  const applyBias = useCallback(async () => {
    if (result?.bettingRecommendations.optimalBias == null) return
    setApplying(true); setError(null); setApplyDetail(null)
    try {
      const res = await fetch('/api/ai-optimizer/apply-bias', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ bias: result.bettingRecommendations.optimalBias }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)

      const { bias, prevBias } = json
      const delta = bias - (prevBias ?? 0)
      const signN = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1)

      setApplied('bias')
      setApplyDetail(
        `✓ Bias guardado en Supabase — efectivo en el próximo ciclo (00:30)\n` +
        `${signN(prevBias ?? 0)}°C → ${signN(bias)}°C (Δ ${signN(delta)}°C) · ` +
        `Hit rate esperado: ${result.bettingRecommendations.expectedHitRate.toFixed(1)}%`
      )
    } catch (e: any) {
      setError(`Error aplicando bias: ${e.message}`)
    } finally {
      setApplying(false)
    }
  }, [result])

  const w  = result?.weightRecommendations
  const b  = result?.bettingRecommendations
  const bd = b?.biasDistribution ?? []

  return (
    <div className="space-y-6">
      {/* ── Controles ──────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h2 className="text-white font-semibold text-sm">🤖 Optimizador IA — Pesos & Bias</h2>

        <div className="flex flex-wrap gap-3">
          {/* Modo */}
          <div className="space-y-1">
            <p className="text-gray-500 text-xs">Modo</p>
            <div className="flex gap-1">
              {(['full', 'weights', 'bias'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                    mode === m
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {m === 'full' ? '🔀 Completo' : m === 'weights' ? '⚖️ Pesos' : '🎯 Bias'}
                </button>
              ))}
            </div>
          </div>

          {/* Lookback */}
          <div className="space-y-1">
            <p className="text-gray-500 text-xs">Ventana histórica</p>
            <div className="flex gap-1">
              {[30, 60, 90].map(d => (
                <button
                  key={d}
                  onClick={() => setLookback(d)}
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                    lookback === d
                      ? 'bg-gray-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={runOptimizer}
          disabled={loading}
          className="w-full bg-blue-700 hover:bg-blue-600 disabled:opacity-50
                     text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
        >
          {loading ? '⏳ Analizando datos con IA…' : '▶ Ejecutar optimización'}
        </button>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-xs px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {/* Feedback de aplicación ─────────────────────────────────────────── */}
        {applyDetail && (
          <div className="bg-green-950 border border-green-800 text-green-300 text-xs px-4 py-3 rounded-lg whitespace-pre-line">
            {applyDetail}
            <p className="text-green-600 mt-1.5">
              El evento queda registrado en el log del bot (pestaña Betting → Eventos).
            </p>
          </div>
        )}
      </div>

      {result && (
        <>
          {/* ── Sección 1: Pesos de fuentes ─────────────────────────────── */}
          {w && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-medium text-sm">⚖️ Pesos recomendados por fuente</h3>
                <div className="flex items-center gap-2">
                  {w.improvedVsPrev !== 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
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

              <div className="flex items-center gap-2 pt-1 border-t border-gray-800">
                <span className="text-gray-500 text-xs">MAE esperado con nuevos pesos:</span>
                <span className="text-blue-300 text-xs font-mono">{flt(w.expectedMAE, 3)}°C</span>
              </div>

              <p className="text-gray-500 text-xs leading-relaxed italic">{w.rationale}</p>
            </div>
          )}

          {/* ── Sección 2: Bias + propuesta apuesta ─────────────────────── */}
          {b && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-medium text-sm">🎯 Bias óptimo y propuesta de apuesta</h3>
                <button
                  onClick={applyBias}
                  disabled={applying}
                  className="text-xs bg-purple-800 hover:bg-purple-700 text-purple-100
                             px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                >
                  {applied === 'bias' ? '✓ Aplicado' : 'Aplicar bias'}
                </button>
              </div>

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

              {bd.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-gray-600 mb-2">
                    Simulación de hit rate por valor de bias:
                  </p>
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

              <p className="text-gray-500 text-xs leading-relaxed italic">{b.rationale}</p>
            </div>
          )}

          {/* ── Insights y warnings ──────────────────────────────────────── */}
          {((result.insights?.length ?? 0) > 0 || (result.warnings?.length ?? 0) > 0) && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
              <h3 className="text-white font-medium text-sm">💡 Insights y advertencias</h3>
              {result.insights?.map((ins, i) => (
                <p key={i} className="text-gray-400 text-xs flex gap-2">
                  <span className="text-blue-400">›</span> {ins}
                </p>
              ))}
              {result.warnings?.map((w, i) => (
                <p key={i} className="text-yellow-500 text-xs flex gap-2">
                  <span>⚠</span> {w}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
