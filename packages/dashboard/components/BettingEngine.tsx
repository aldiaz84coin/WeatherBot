'use client'
// packages/dashboard/components/BettingEngine.tsx
//
// CAMBIO: las queries de Supabase se hacen ahora via /api/betting/status
// (server-side) en lugar de directamente desde el browser.
// Esto evita errores CORS en redes corporativas que bloquean *.supabase.co.
// El Realtime WebSocket también se elimina (bloqueado por las mismas redes);
// se usa polling cada 60 s como única fuente de refresco.
//
// FIX 1: "Stake actual" ahora muestra el stake EFECTIVO SIGUIENTE =
//         min(base_stake * current_multiplier, max_stake)
//         en vez de latest_stake (stake del último ciclo pasado).
// FIX 2: El badge de modo usa status.betting_mode que ya viene sin comillas
//         desde el API route (donde se normalizan las comillas JSONB).

import { useEffect, useState, useCallback } from 'react'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface BettingStatus {
  latest_cycle_id:    string | null
  latest_date:        string | null
  latest_status:      string | null
  latest_stake:       number | null
  latest_multiplier:  number | null
  token_a_temp:       number | null
  token_b_temp:       number | null
  shares:             number | null
  cost_a_usdc:        number | null
  cost_b_usdc:        number | null
  actual_temp:        number | null
  is_settled:         boolean | null
  latest_pnl:         number | null
  simulated:          boolean | null
  base_stake:         number | null
  max_stake:          number | null
  current_multiplier: number | null
  consecutive_losses: number | null
  betting_mode:       string | null
  total_cycles:       number | null
  won_cycles:         number | null
  lost_cycles:        number | null
  total_pnl:          number | null
  hit_rate_pct:       number | null
}

interface BettingCycle {
  id:            string
  target_date:   string
  stake_usdc:    number
  multiplier:    number
  token_a_temp:  number | null
  token_b_temp:  number | null
  actual_temp:   number | null
  status:        string
  pnl_usdc:      number | null
  simulated:     boolean
  capped_at_max: boolean | null
}

interface TomorrowCycle {
  id:                string
  target_date:       string
  stake_usdc:        number
  multiplier:        number
  token_a_temp:      number | null
  token_b_temp:      number | null
  status:            string
  simulated:         boolean
  prediction_id:     string | null
  ensemble_temp:     number | null
  ensemble_adjusted: number | null
  bias_applied:      number | null
  cost_a_usdc:       number | null
  cost_b_usdc:       number | null
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

function formatTemp(t: number | null): string {
  return t != null ? `${t.toFixed(1)}°C` : '—'
}

function pnlColor(pnl: number | null) {
  if (pnl === null) return 'text-gray-500'
  return pnl >= 0 ? 'text-green-400' : 'text-red-400'
}

function multiplierBar(mult: number | null, max: number | null, base: number | null) {
  if (!mult || !max || !base) return null
  const pct   = Math.min((Math.log2(mult) / Math.log2(max / base)) * 100, 100)
  const color = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-blue-500'
  return { pct, color }
}

/** Stake efectivo que se usará en el PRÓXIMO ciclo. */
function computeNextStake(status: BettingStatus): number | null {
  if (status.base_stake == null || status.current_multiplier == null) return null
  const raw = status.base_stake * status.current_multiplier
  return parseFloat(Math.min(raw, status.max_stake ?? raw).toFixed(2))
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    open:      'bg-blue-950 text-blue-400 border-blue-900',
    won:       'bg-green-950 text-green-400 border-green-900',
    lost:      'bg-red-950 text-red-400 border-red-900',
    skipped:   'bg-gray-800 text-gray-500 border-gray-700',
    cancelled: 'bg-gray-800 text-gray-500 border-gray-700',
  }
  return map[status] ?? 'bg-gray-800 text-gray-400 border-gray-700'
}

// ─── NoDataState ──────────────────────────────────────────────────────────────

function NoDataState() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col items-center justify-center text-center gap-3">
      <span className="text-3xl">🎯</span>
      <div>
        <p className="text-gray-300 font-medium text-sm">Sin ciclos registrados</p>
        <p className="text-gray-600 text-xs mt-1 max-w-xs">
          El motor ejecutará el primer ciclo a las <span className="text-gray-400">00:30 (Madrid)</span>.
        </p>
      </div>
    </div>
  )
}

// ─── Panel: Ciclo de Mañana ───────────────────────────────────────────────────

function TomorrowCyclePanel({ cycle, onRefresh }: {
  cycle: TomorrowCycle
  onRefresh: () => void
}) {
  const [buying, setBuying] = useState(false)
  const [buyMsg, setBuyMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const handleLaunchOrder = async () => {
    setBuying(true)
    setBuyMsg(null)
    try {
      const res  = await fetch('/api/betting/retry-orders', { method: 'POST' })
      const data = await res.json()
      setBuyMsg(res.ok
        ? { ok: true,  text: data.message ?? 'Órdenes enviadas — resultado en el log en ~30 s.' }
        : { ok: false, text: data.error   ?? 'Error desconocido' }
      )
    } catch {
      setBuyMsg({ ok: false, text: 'Error de red' })
    } finally {
      setBuying(false)
      setTimeout(() => { onRefresh(); setBuyMsg(null) }, 6_000)
    }
  }

  const isLive = !cycle.simulated

  return (
    <div className={`rounded-xl border p-4 ${
      isLive
        ? 'bg-green-950/10 border-green-900/50'
        : 'bg-yellow-950/10 border-yellow-900/30'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Ciclo de mañana — {cycle.target_date}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            {isLive ? '🔴 Modo live — órdenes reales' : '🟡 Modo simulado'}
          </p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border font-medium ${statusBadge(cycle.status)}`}>
          {cycle.status}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-[10px] text-gray-500 uppercase">Stake</p>
          <p className="font-semibold text-white">{cycle.stake_usdc} USDC</p>
          {cycle.multiplier > 1 && (
            <p className="text-[10px] text-yellow-500">×{cycle.multiplier} Martingala</p>
          )}
        </div>
        <div>
          <p className="text-[10px] text-gray-500 uppercase">Token A</p>
          <p className="font-semibold text-white">{cycle.token_a_temp != null ? `${cycle.token_a_temp}°C` : '—'}</p>
          {cycle.cost_a_usdc != null && (
            <p className="text-[10px] text-gray-500">${cycle.cost_a_usdc.toFixed(2)}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] text-gray-500 uppercase">Token B</p>
          <p className="font-semibold text-white">{cycle.token_b_temp != null ? `${cycle.token_b_temp}°C` : '—'}</p>
          {cycle.cost_b_usdc != null && (
            <p className="text-[10px] text-gray-500">${cycle.cost_b_usdc.toFixed(2)}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] text-gray-500 uppercase">Ensemble adj.</p>
          <p className="font-semibold text-white">
            {cycle.ensemble_adjusted != null ? `${cycle.ensemble_adjusted.toFixed(2)}°C` : '—'}
          </p>
          {cycle.bias_applied != null && (
            <p className="text-[10px] text-gray-500">
              bias {cycle.bias_applied >= 0 ? '+' : ''}{cycle.bias_applied.toFixed(2)}°C
            </p>
          )}
        </div>
      </div>

      {/* Botón compra manual si live y hay tokens */}
      {isLive && cycle.token_a_temp != null && cycle.token_b_temp != null && cycle.status === 'open' && (
        <div className="mt-3 space-y-2">
          <button
            onClick={handleLaunchOrder}
            disabled={buying}
            className={`w-full py-2 text-xs rounded-lg border font-medium transition-all ${
              buying
                ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-green-900 border-green-700 text-green-200 hover:bg-green-800 hover:border-green-500 cursor-pointer'
            }`}
          >
            <span className={buying ? 'animate-spin inline-block' : ''}>{buying ? '⏳' : '🛒'}</span>
            {buying
              ? 'Enviando al bot…'
              : `Lanzar compra — ${cycle.token_a_temp}°C / ${cycle.token_b_temp}°C`}
          </button>
          {buyMsg && (
            <p className={`text-xs text-center ${buyMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
              {buyMsg.ok ? '✅' : '❌'} {buyMsg.text}
            </p>
          )}
          <p className="text-[10px] text-gray-600 text-center">
            El bot ejecutará las órdenes CLOB en Polymarket en ≤30 s · el error exacto aparece en el log
          </p>
        </div>
      )}

      {cycle.simulated && (
        <p className="text-xs text-yellow-600 text-center mt-2">
          ⚠️ Ciclo simulado — activa modo live para ejecutar órdenes reales
        </p>
      )}
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function BettingEngine() {
  const [status, setStatus]               = useState<BettingStatus | null>(null)
  const [cycles, setCycles]               = useState<BettingCycle[]>([])
  const [tomorrowCycle, setTomorrowCycle] = useState<TomorrowCycle | null>(null)
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [retrying, setRetrying]           = useState(false)
  const [retryMsg, setRetryMsg]           = useState<{ ok: boolean; text: string } | null>(null)

  const tomorrowStr = getMadridTomorrow()

  // ── Carga vía API route (server-side → sin CORS) ──────────────────────────
  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/betting/status?tomorrow=${tomorrowStr}`)
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      const { status: st, cycles: cy, tomorrowCycle: tmw } = await res.json()

      setStatus(st)
      setCycles(cy ?? [])

      if (tmw) {
        const pred = (tmw as any).predictions
        setTomorrowCycle({
          id:                tmw.id,
          target_date:       tmw.target_date,
          stake_usdc:        tmw.stake_usdc,
          multiplier:        tmw.multiplier,
          token_a_temp:      tmw.token_a_temp ?? pred?.token_a ?? null,
          token_b_temp:      tmw.token_b_temp ?? pred?.token_b ?? null,
          status:            tmw.status,
          simulated:         tmw.simulated,
          prediction_id:     tmw.prediction_id,
          ensemble_temp:     pred?.ensemble_temp     ?? null,
          ensemble_adjusted: pred?.ensemble_adjusted ?? null,
          bias_applied:      pred?.bias_applied      ?? null,
          cost_a_usdc:       pred?.cost_a_usdc       ?? null,
          cost_b_usdc:       pred?.cost_b_usdc       ?? null,
        })
      } else {
        setTomorrowCycle(null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tomorrowStr])

  const handleRetryCycle = useCallback(async () => {
    setRetrying(true)
    setRetryMsg(null)
    try {
      const res  = await fetch('/api/betting/retry-cycle', { method: 'POST' })
      const data = await res.json()
      setRetryMsg(res.ok
        ? { ok: true,  text: data.message ?? 'Ciclo se relanzará en ~30 s.' }
        : { ok: false, text: data.error   ?? 'Error desconocido' }
      )
    } catch {
      setRetryMsg({ ok: false, text: 'Error de red al contactar con la API' })
    } finally {
      setRetrying(false)
      setTimeout(() => { load(); setRetryMsg(null) }, 5_000)
    }
  }, [load])

  // ── Polling cada 60s (sin Realtime WebSocket — bloqueado en redes corp.) ──
  useEffect(() => {
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [load])

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center gap-3">
        <div className="w-4 h-4 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
        <span className="text-gray-500 text-sm">Cargando motor de apuestas…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-950/40 border border-red-900 rounded-xl p-4 text-red-400 text-sm">
        Error cargando motor: {error}
      </div>
    )
  }

  if (!status && cycles.length === 0 && !tomorrowCycle) {
    return <NoDataState />
  }

  const bar = multiplierBar(
    status?.current_multiplier ?? null,
    status?.max_stake          ?? null,
    status?.base_stake         ?? null,
  )

  // Stake efectivo que se usará en el PRÓXIMO ciclo (no el del último ciclo)
  const nextStake = status ? computeNextStake(status) : null

  // Modo normalizado (el API route ya quita las comillas JSONB)
  const isLive = status?.betting_mode === 'live'

  return (
    <div className="space-y-4">

      {/* ── KPIs ── */}
      {status && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
              Estado del motor
            </h2>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded border font-medium ${
                isLive
                  ? 'bg-green-950 text-green-400 border-green-900'
                  : 'bg-yellow-950 text-yellow-600 border-yellow-900'
              }`}>
                {isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500">Ciclos totales</p>
              <p className="text-2xl font-bold text-white mt-0.5">{status.total_cycles ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Hit rate</p>
              <p className="text-2xl font-bold text-white mt-0.5">
                {status.hit_rate_pct != null ? `${status.hit_rate_pct}%` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">PnL total</p>
              <p className={`text-2xl font-bold mt-0.5 ${pnlColor(status.total_pnl ?? null)}`}>
                {status.total_pnl != null
                  ? `${status.total_pnl >= 0 ? '+' : ''}${status.total_pnl.toFixed(2)} USDC`
                  : '—'}
              </p>
            </div>
            <div>
              {/* FIX: mostrar stake EFECTIVO SIGUIENTE (base × mult), no el último ciclo */}
              <p className="text-xs text-gray-500">
                Próximo stake
                {status.current_multiplier != null && status.current_multiplier > 1 && (
                  <span className="text-yellow-600 ml-1">×{status.current_multiplier}</span>
                )}
              </p>
              <p className="text-2xl font-bold text-white mt-0.5">
                {nextStake != null ? `${nextStake} USDC` : '—'}
              </p>
              {status.base_stake != null && (
                <p className="text-[10px] text-gray-600">base: {status.base_stake} USDC</p>
              )}
            </div>
          </div>

          {/* Barra Martingala */}
          {bar && (
            <div className="mt-4 space-y-1">
              <p className="text-xs text-gray-500">
                Martingala: {status.consecutive_losses ?? 0} pérdida(s) consecutiva(s)
              </p>
              <p className="text-xs text-gray-500 font-mono">
                {nextStake ?? '—'} / {status.max_stake ?? '—'} USDC
              </p>
              <div className="w-full bg-gray-800 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full transition-all ${bar.color}`}
                  style={{ width: `${bar.pct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Ciclo de mañana ── */}
      {tomorrowCycle ? (
        <TomorrowCyclePanel cycle={tomorrowCycle} onRefresh={load} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">Sin ciclo programado para mañana ({tomorrowStr})</p>
            <button
              onClick={handleRetryCycle}
              disabled={retrying}
              className="text-xs px-3 py-1.5 rounded-lg bg-blue-900 border border-blue-800
                         text-blue-300 hover:bg-blue-800 transition-colors disabled:opacity-50"
            >
              {retrying ? '⏳ Relanzando…' : '🔄 Forzar ciclo'}
            </button>
          </div>
          {retryMsg && (
            <p className={`text-xs ${retryMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
              {retryMsg.ok ? '✅' : '❌'} {retryMsg.text}
            </p>
          )}
        </div>
      )}

      {/* ── Historial de ciclos ── */}
      {cycles.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Historial de ciclos
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="px-4 py-2 text-left">Fecha</th>
                  <th className="px-4 py-2 text-left">Modo</th>
                  <th className="px-4 py-2 text-right">Tokens</th>
                  <th className="px-4 py-2 text-right">T. real</th>
                  <th className="px-4 py-2 text-right">Stake</th>
                  <th className="px-4 py-2 text-right">PnL</th>
                  <th className="px-4 py-2 text-right">Estado</th>
                </tr>
              </thead>
              <tbody>
                {cycles.map(c => (
                  <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="px-4 py-2 text-gray-300">
                      {format(parseISO(c.target_date), 'dd MMM', { locale: es })}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] ${c.simulated ? 'text-yellow-600' : 'text-green-500'}`}>
                        {c.simulated ? 'SIM' : 'LIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-gray-400 font-mono">
                      {c.token_a_temp != null ? `${c.token_a_temp}°C` : '—'}
                      {' / '}
                      {c.token_b_temp != null ? `${c.token_b_temp}°C` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-300 font-mono">
                      {formatTemp(c.actual_temp)}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-300 font-mono">
                      {c.stake_usdc} USDC
                      {c.capped_at_max && (
                        <span className="ml-1 text-red-500 text-[10px]">MAX</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono font-semibold ${pnlColor(c.pnl_usdc)}`}>
                      {c.pnl_usdc != null
                        ? `${c.pnl_usdc >= 0 ? '+' : ''}${c.pnl_usdc.toFixed(2)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-medium ${statusBadge(c.status)}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
