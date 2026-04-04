'use client'
// packages/dashboard/components/ManualBuyPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Panel de Compra Manual — fuera del ciclo automático del bot.
//
// Flujo:
//   1. Seleccionar fecha y stake
//   2. "Consultar precios" → GET /api/betting/manual-buy → preview con debug
//   3. Revisar configuración aplicada (pesos + bias) + tokens calculados
//   4. "Ejecutar compra real" → POST /api/betting/manual-buy → resultado + debug
//
// FIX: ahora muestra el panel "Configuración aplicada" con pesos y bias
// para que el usuario pueda verificar que la predicción usa la config correcta.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react'
import { format } from 'date-fns'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TokenInfo {
  tempCelsius: number
  label:       string
  tokenId:     string
  slug:        string
  price:       number
  cost:        number
  shares:      number | null
  found:       boolean
}

interface Position {
  tokenA:       TokenInfo
  tokenB:       TokenInfo
  shares:       number
  priceSum:     number
  stake:        number
  ensembleTemp: number
}

interface WeightEntry {
  slug:   string
  name:   string
  weight: number
}

interface ConfigApplied {
  ensembleRaw:      number | null
  biasN:            number
  ensembleAdjusted: number | null
  tokenA:           number | null
  tokenB:           number | null
  weights:          WeightEntry[]
  source:           'prediction_with_bias' | 'prediction_bias_recalculated' | 'fallback_no_prediction'
  predictionId:     string | null
}

interface PreviewResult {
  date:          string
  stake:         number
  available:     boolean
  tokens:        { tempCelsius: number; label: string; price: number; slug: string }[]
  position:      Position | null
  configApplied: ConfigApplied | null
  debug:         any
}

interface ExecuteResult {
  ok:           boolean
  cycleId?:     string
  position?:    Position
  orders?:      {
    slot:     'a' | 'b'
    temp:     number
    tokenId:  string
    price:    number
    cost:     number
    success:  boolean
    orderId:  string | null
    status:   string | null
    error:    string | null
  }[]
  successCount?: number
  debug?:        any
  error?:        string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMadridTomorrow(): string {
  const now = new Date()
  const madridStr = now.toLocaleString('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const [y, m, d] = madridStr.split(/[-/]/).map(Number)
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1))
  return format(tomorrow, 'yyyy-MM-dd')
}

const SLUG_SHORT: Record<string, string> = {
  'open-meteo':      'OM',
  'aemet':           'AEM',
  'visual-crossing': 'VCR',
  'weatherapi':      'WAP',
  'openweathermap':  'OWM',
  'tomorrow-io':     'TMR',
  'accuweather':     'ACU',
}

function shortSlug(slug: string) {
  return SLUG_SHORT[slug] ?? slug.toUpperCase().slice(0, 3)
}

function weightColor(w: number) {
  if (w >= 0.25) return 'bg-blue-900 border-blue-700 text-blue-200'
  if (w >= 0.15) return 'bg-gray-800 border-gray-600 text-gray-200'
  return 'bg-gray-900 border-gray-700 text-gray-500'
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function DebugPanel({ data, title }: { data: any; title: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-800/50 hover:bg-gray-800 transition-colors"
      >
        <span className="text-xs text-gray-400 font-mono">🔍 {title}</span>
        <span className="text-gray-600 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <pre className="text-[10px] text-gray-400 bg-gray-950 p-3 overflow-x-auto max-h-80 leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

/** Panel que muestra la configuración de pesos y bias realmente aplicada. */
function ConfigAppliedPanel({ config }: { config: ConfigApplied }) {
  const sourceLabel: Record<ConfigApplied['source'], string> = {
    prediction_with_bias:        '✅ Predicción guardada con bias incorporado',
    prediction_bias_recalculated: '⚠️ Predicción sin ensemble_adjusted — se aplicó bias actual',
    fallback_no_prediction:       '⚠️ Sin predicción guardada — ensemble estimado desde precios de mercado',
  }
  const sourceColor: Record<ConfigApplied['source'], string> = {
    prediction_with_bias:        'text-green-400',
    prediction_bias_recalculated: 'text-yellow-400',
    fallback_no_prediction:       'text-orange-400',
  }

  const signN = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(3)

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          ⚙️ Configuración aplicada
        </p>
        <span className={`text-[10px] ${sourceColor[config.source]}`}>
          {sourceLabel[config.source]}
        </span>
      </div>

      {/* Cálculo ensemble → tokens */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div className="bg-gray-900 rounded-lg p-2">
          <p className="text-[9px] text-gray-500 uppercase">Ensemble bruto</p>
          <p className="text-sm font-bold text-white mt-0.5">
            {config.ensembleRaw != null ? `${config.ensembleRaw.toFixed(3)}°C` : '—'}
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg p-2">
          <p className="text-[9px] text-gray-500 uppercase">Bias N</p>
          <p className={`text-sm font-bold mt-0.5 ${
            config.biasN > 0.3  ? 'text-orange-300' :
            config.biasN < -0.3 ? 'text-blue-300'   : 'text-gray-300'
          }`}>
            {signN(config.biasN)}°C
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg p-2">
          <p className="text-[9px] text-gray-500 uppercase">Ensemble adj.</p>
          <p className="text-sm font-bold text-white mt-0.5">
            {config.ensembleAdjusted != null ? `${config.ensembleAdjusted.toFixed(3)}°C` : '—'}
          </p>
        </div>
        <div className="bg-blue-950 border border-blue-900 rounded-lg p-2">
          <p className="text-[9px] text-blue-400 uppercase">Tokens ceil</p>
          <p className="text-sm font-bold text-blue-200 mt-0.5">
            {config.tokenA != null ? `${config.tokenA}°C / ${config.tokenB}°C` : '—'}
          </p>
        </div>
      </div>

      {/* Pesos de fuentes */}
      {config.weights.length > 0 && (
        <div>
          <p className="text-[10px] text-gray-600 mb-1.5">Pesos del ensemble</p>
          <div className="flex flex-wrap gap-1.5">
            {config.weights.map(w => (
              <div
                key={w.slug}
                className={`flex items-center gap-1 rounded-md px-2 py-1 border text-xs ${weightColor(w.weight)}`}
                title={w.name}
              >
                <span className="font-mono text-[9px] opacity-70">{shortSlug(w.slug)}</span>
                <span className="font-semibold tabular-nums">{Math.round(w.weight * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {config.predictionId && (
        <p className="text-[9px] text-gray-700 font-mono">
          prediction_id: {config.predictionId}
        </p>
      )}
    </div>
  )
}

function TokenCard({
  slot,
  token,
  highlight,
}: {
  slot: 'A' | 'B'
  token: TokenInfo
  highlight: boolean
}) {
  return (
    <div className={`rounded-lg border p-3 space-y-1 ${
      !token.found
        ? 'border-red-900 bg-red-950/20'
        : highlight
          ? 'border-blue-800 bg-blue-950/20'
          : 'border-gray-800 bg-gray-900'
    }`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-400 uppercase">Token {slot}</span>
        <span className={`text-sm font-bold ${token.found ? 'text-white' : 'text-red-400'}`}>
          {token.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center pt-1">
        <div>
          <p className="text-[9px] text-gray-500 uppercase">Precio</p>
          <p className="text-xs font-semibold text-white">
            {token.price > 0 ? `${(token.price * 100).toFixed(1)}¢` : <span className="text-gray-600">N/D</span>}
          </p>
        </div>
        <div>
          <p className="text-[9px] text-gray-500 uppercase">Coste</p>
          <p className="text-xs font-semibold text-white">
            ${token.cost.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[9px] text-gray-500 uppercase">Shares</p>
          <p className="text-xs font-semibold text-white">
            {token.shares != null ? token.shares.toFixed(2) : '—'}
          </p>
        </div>
      </div>
      {!token.found && (
        <p className="text-[10px] text-red-400">⚠️ Token no encontrado en el mercado</p>
      )}
      {token.tokenId && (
        <p className="text-[9px] text-gray-600 font-mono truncate">ID: {token.tokenId.substring(0, 20)}…</p>
      )}
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function ManualBuyPanel() {
  const [date,        setDate]        = useState(getMadridTomorrow())
  const [stake,       setStake]       = useState(20)
  const [loading,     setLoading]     = useState(false)
  const [executing,   setExecuting]   = useState(false)
  const [preview,     setPreview]     = useState<PreviewResult | null>(null)
  const [result,      setResult]      = useState<ExecuteResult | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // ── Consultar precios ─────────────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    setPreview(null)
    setResult(null)
    setConfirmOpen(false)
    try {
      const res = await fetch(`/api/betting/manual-buy?date=${date}&stake=${stake}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setPreview(data)
    } catch (e: any) {
      setError(e.message ?? 'Error de red')
    } finally {
      setLoading(false)
    }
  }, [date, stake])

  // ── Ejecutar compra real ──────────────────────────────────────────────────
  const handleExecute = useCallback(async () => {
    setExecuting(true)
    setError(null)
    setResult(null)
    setConfirmOpen(false)
    try {
      const res = await fetch('/api/betting/manual-buy', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date, stake, execute: true }),
      })
      const data = await res.json()
      setResult(data)
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
      }
    } catch (e: any) {
      setError(e.message ?? 'Error de red')
    } finally {
      setExecuting(false)
    }
  }, [date, stake])

  return (
    <section className="bg-gray-900 border border-orange-900/50 rounded-xl overflow-hidden">

      {/* ── Header ── */}
      <div className="px-5 py-4 border-b border-gray-800 bg-orange-950/10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-orange-300">🛒 Compra Manual</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Operación adicional fuera del ciclo automático · registra como trade real
            </p>
          </div>
          <span className="text-xs bg-orange-950 text-orange-400 border border-orange-900 px-2 py-0.5 rounded font-medium">
            DEBUG
          </span>
        </div>
      </div>

      <div className="p-5 space-y-5">

        {/* ── Controles ── */}
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-gray-500 block mb-1">Fecha objetivo</label>
            <input
              type="date"
              value={date}
              onChange={e => { setDate(e.target.value); setPreview(null); setResult(null) }}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-orange-600"
            />
          </div>
          <div className="w-32">
            <label className="text-xs text-gray-500 block mb-1">Stake (USDC)</label>
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={stake}
              onChange={e => { setStake(Math.max(1, Number(e.target.value))); setPreview(null); setResult(null) }}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-orange-600"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={handlePreview}
              disabled={loading || executing}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700
                         text-white text-sm rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? '⏳ Cargando…' : '🔍 Consultar precios'}
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-950/40 border border-red-900 rounded-lg px-4 py-3 text-red-400 text-xs">
            ❌ {error}
          </div>
        )}

        {/* ── Preview ── */}
        {preview && !result && (
          <div className="space-y-4">

            {/* Configuración aplicada (pesos + bias) */}
            {preview.configApplied && (
              <ConfigAppliedPanel config={preview.configApplied} />
            )}

            {/* Tokens disponibles en el mercado */}
            {preview.tokens.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  Tokens en mercado ({preview.tokens.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {preview.tokens.map(t => (
                    <div
                      key={t.tempCelsius}
                      className={`text-xs px-2 py-1 rounded-md border ${
                        preview.configApplied?.tokenA === t.tempCelsius ||
                        preview.configApplied?.tokenB === t.tempCelsius
                          ? 'bg-blue-950 border-blue-800 text-blue-300'
                          : 'bg-gray-800 border-gray-700 text-gray-400'
                      }`}
                    >
                      {t.tempCelsius}°C · {(t.price * 100).toFixed(1)}¢
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!preview.available && (
              <div className="bg-yellow-950/30 border border-yellow-900 rounded-lg px-4 py-3 text-yellow-400 text-xs">
                ⚠️ Mercado no disponible para esta fecha — el mercado puede que aún no esté creado en Polymarket.
              </div>
            )}

            {/* Posición calculada */}
            {preview.position && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500">Posición calculada</p>
                  <p className="text-xs text-gray-600">
                    ensemble adj: {preview.position.ensembleTemp.toFixed(3)}°C · priceSum: {(preview.position.priceSum * 100).toFixed(1)}¢
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TokenCard slot="A" token={preview.position.tokenA} highlight={false} />
                  <TokenCard slot="B" token={preview.position.tokenB} highlight={false} />
                </div>
              </div>
            )}

            {/* Debug fetch */}
            <DebugPanel data={preview.debug} title="Debug — respuesta Polymarket Gamma API" />

            {/* Botón ejecutar */}
            {preview.available && preview.position && (
              <div className="pt-2 space-y-2">
                {!confirmOpen ? (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    className="w-full py-2.5 rounded-lg text-sm font-semibold border
                               bg-orange-900 border-orange-700 text-orange-200
                               hover:bg-orange-800 hover:border-orange-600 transition-all"
                  >
                    🛒 Ejecutar compra real — ${stake} USDC
                  </button>
                ) : (
                  <div className="bg-red-950/30 border border-red-800 rounded-lg p-4 space-y-3">
                    <p className="text-sm text-red-300 font-medium">
                      ⚠️ Esto ejecutará órdenes REALES en Polymarket
                    </p>
                    <p className="text-xs text-red-400">
                      Tokens: {preview.position.tokenA.tempCelsius}°C / {preview.position.tokenB.tempCelsius}°C ·
                      Coste total: ~${(preview.position.tokenA.cost + preview.position.tokenB.cost).toFixed(2)} USDC
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleExecute}
                        disabled={executing}
                        className="px-4 py-1.5 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
                      >
                        {executing ? '⏳ Ejecutando…' : '✅ Confirmar compra'}
                      </button>
                      <button
                        onClick={() => setConfirmOpen(false)}
                        className="px-4 py-1.5 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Resultado ── */}
        {result && (
          <div className="space-y-3">
            <div className={`rounded-lg border px-4 py-3 ${
              result.ok
                ? 'bg-green-950/30 border-green-900'
                : 'bg-red-950/30 border-red-900'
            }`}>
              <p className={`text-sm font-medium ${result.ok ? 'text-green-300' : 'text-red-300'}`}>
                {result.ok ? '✅ Compra registrada correctamente' : '❌ Error en la compra'}
              </p>
              {result.ok && (
                <p className="text-xs text-gray-400 mt-1">
                  El bot ejecutará las órdenes CLOB en Polymarket en los próximos 30 s.
                </p>
              )}
            </div>

            {result.orders && result.orders.length > 0 && (
              <div className="space-y-2">
                {result.orders.map(o => (
                  <div
                    key={o.slot}
                    className={`rounded-lg border p-3 text-xs ${
                      o.success
                        ? 'border-green-900 bg-green-950/20'
                        : 'border-red-900 bg-red-950/20'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-300">Token {o.slot.toUpperCase()} — {o.temp}°C</span>
                      <span className={o.success ? 'text-green-400' : 'text-red-400'}>
                        {o.success ? '✅' : '❌'}
                      </span>
                    </div>
                    <div className="text-gray-500 space-y-0.5 mt-1">
                      <p>Precio: {(o.price * 100).toFixed(1)}¢ · Coste: ${o.cost.toFixed(2)}</p>
                      {o.orderId && <p className="font-mono">orderId: {o.orderId}</p>}
                      {o.status  && <p>status: <span className="text-gray-300">{o.status}</span></p>}
                      {o.error   && <p className="text-red-400">{o.error}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result.debug && (
              <DebugPanel data={result.debug} title="Debug completo — todas las llamadas API" />
            )}

            <button
              onClick={() => { setResult(null); setPreview(null) }}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              ← Nueva consulta
            </button>
          </div>
        )}

      </div>
    </section>
  )
}
