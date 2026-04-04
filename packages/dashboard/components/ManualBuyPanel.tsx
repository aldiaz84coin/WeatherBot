'use client'
// packages/dashboard/components/ManualBuyPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Panel de Compra Manual — fuera del ciclo automático del bot.
//
// Flujo:
//   1. Seleccionar fecha y stake
//   2. "Consultar precios" → GET /api/betting/manual-buy → preview con debug
//   3. Revisar tokens, precios, costes
//   4. "Ejecutar compra real" → POST /api/betting/manual-buy → resultado + debug
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react'
import { format, addDays } from 'date-fns'

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
  tokenA:      TokenInfo
  tokenB:      TokenInfo
  shares:      number
  priceSum:    number
  stake:       number
  ensembleTemp: number
}

interface PreviewResult {
  date:      string
  stake:     number
  available: boolean
  tokens:    { tempCelsius: number; label: string; price: number; slug: string }[]
  position:  Position | null
  debug:     any
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
  debug?:       any
  error?:       string
}

// ─── Helper ───────────────────────────────────────────────────────────────────

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
              {loading
                ? <span className="animate-spin inline-block mr-1">⏳</span>
                : '🔍'} Consultar precios
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-950/40 border border-red-900 rounded-lg px-4 py-3 text-red-300 text-xs">
            ❌ {error}
          </div>
        )}

        {/* ── Preview de precios ── */}
        {preview && !result && (
          <div className="space-y-4">

            {/* Estado del mercado */}
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${preview.available ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-xs text-gray-400">
                Mercado {preview.available ? 'disponible' : 'no disponible'} · {preview.tokens.length} tokens · {date}
              </span>
              <span className="text-xs text-gray-600 ml-auto">
                Stake: ${preview.stake} USDC
              </span>
            </div>

            {/* Todos los tokens disponibles */}
            {preview.tokens.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-2">Tokens disponibles en el mercado</p>
                <div className="flex flex-wrap gap-1.5">
                  {preview.tokens.map(t => (
                    <div
                      key={t.tempCelsius}
                      className={`text-xs px-2 py-1 rounded border font-mono ${
                        preview.position &&
                        (t.tempCelsius === preview.position.tokenA.tempCelsius ||
                         t.tempCelsius === preview.position.tokenB.tempCelsius)
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

            {/* Posición calculada */}
            {preview.position && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500">Posición calculada</p>
                  <p className="text-xs text-gray-600">
                    ensemble: {preview.position.ensembleTemp.toFixed(2)}°C · priceSum: {(preview.position.priceSum * 100).toFixed(1)}¢
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
                        className="px-4 py-1.5 rounded-lg text-sm text-gray-400 bg-gray-800 hover:bg-gray-700 transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-gray-600 text-center">
                  Esta compra NO afecta al ciclo automático ni a la lógica Martingala del bot
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Resultado de ejecución ── */}
        {result && (
          <div className="space-y-4">

            {/* Estado general */}
            <div className={`rounded-xl border p-4 ${
              result.ok && (result.successCount ?? 0) === 2
                ? 'bg-green-950/20 border-green-800'
                : result.ok && (result.successCount ?? 0) > 0
                  ? 'bg-yellow-950/20 border-yellow-800'
                  : 'bg-red-950/20 border-red-800'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <p className={`text-sm font-semibold ${
                  (result.successCount ?? 0) === 2
                    ? 'text-green-300'
                    : (result.successCount ?? 0) > 0
                      ? 'text-yellow-300'
                      : 'text-red-300'
                }`}>
                  {(result.successCount ?? 0) === 2
                    ? '✅ Compra ejecutada — 2/2 órdenes OK'
                    : (result.successCount ?? 0) > 0
                      ? `⚠️ Parcial — ${result.successCount}/2 órdenes OK`
                      : `❌ Fallo — 0/2 órdenes ejecutadas`}
                </p>
                {result.cycleId && (
                  <span className="text-[10px] text-gray-500 font-mono">
                    cycle: {result.cycleId.substring(0, 8)}…
                  </span>
                )}
              </div>

              {/* Detalle de órdenes */}
              {result.orders && (
                <div className="grid grid-cols-2 gap-2 mt-3">
                  {result.orders.map(o => (
                    <div
                      key={o.slot}
                      className={`rounded-lg p-2.5 border text-xs space-y-1 ${
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
                      <div className="text-gray-500 space-y-0.5">
                        <p>Precio: {(o.price * 100).toFixed(1)}¢ · Coste: ${o.cost.toFixed(2)}</p>
                        {o.orderId && (
                          <p className="font-mono">orderId: {o.orderId}</p>
                        )}
                        {o.status && (
                          <p>status: <span className="text-gray-300">{o.status}</span></p>
                        )}
                        {o.error && (
                          <p className="text-red-400">{o.error}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Debug completo */}
            {result.debug && (
              <DebugPanel data={result.debug} title="Debug completo — todas las llamadas API" />
            )}

            {/* Nueva consulta */}
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
