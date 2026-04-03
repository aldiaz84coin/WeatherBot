'use client'
// packages/dashboard/components/BettingEngine.tsx

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

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
  is_settled:         boolean
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
  token_a_temp:  number
  token_b_temp:  number
  actual_temp:   number | null
  status:        string
  pnl_usdc:      number | null
  simulated:     boolean
  capped_at_max: boolean
}

interface TomorrowCycle {
  id:                string
  target_date:       string
  stake_usdc:        number
  multiplier:        number
  token_a_temp:      number
  token_b_temp:      number
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
  const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
  const [y, m, d] = todayMadrid.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

function statusBadge(status: string | null) {
  switch (status) {
    case 'open':    return 'bg-blue-950 text-blue-300 border-blue-800'
    case 'won':     return 'bg-green-950 text-green-300 border-green-800'
    case 'lost':    return 'bg-red-950 text-red-300 border-red-800'
    case 'pending': return 'bg-gray-800 text-gray-400 border-gray-700'
    case 'error':   return 'bg-orange-950 text-orange-300 border-orange-800'
    default:        return 'bg-gray-800 text-gray-500 border-gray-700'
  }
}

function statusLabel(status: string | null) {
  switch (status) {
    case 'open':    return '⏳ Abierto'
    case 'won':     return '✅ Ganado'
    case 'lost':    return '❌ Perdido'
    case 'pending': return '⌛ Pendiente'
    case 'error':   return '⚠️ Error'
    default:        return status ?? '—'
  }
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
      isLive ? 'bg-green-950/10 border-green-900' : 'bg-gray-900 border-gray-800'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Ciclo de mañana</p>
          <span className="text-xs text-gray-500 font-mono">
            {format(parseISO(cycle.target_date), 'dd MMM yyyy', { locale: es })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {cycle.simulated && (
            <span className="text-[10px] text-yellow-600 border border-yellow-900 bg-yellow-950/30 rounded px-1.5 py-0.5">
              simulado
            </span>
          )}
          {isLive && (
            <span className="text-[10px] text-green-400 border border-green-800 bg-green-950/40 rounded px-1.5 py-0.5">
              🔴 live
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded border ${statusBadge(cycle.status)}`}>
            {statusLabel(cycle.status)}
          </span>
        </div>
      </div>

      {/* Datos */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div>
          <p className="text-xs text-gray-600">Token A</p>
          <p className="font-mono text-white font-semibold text-xl">{cycle.token_a_temp}°C</p>
          {cycle.cost_a_usdc != null && (
            <p className="text-xs text-gray-500">${cycle.cost_a_usdc.toFixed(4)}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-gray-600">Token B</p>
          <p className="font-mono text-white font-semibold text-xl">{cycle.token_b_temp}°C</p>
          {cycle.cost_b_usdc != null && (
            <p className="text-xs text-gray-500">${cycle.cost_b_usdc.toFixed(4)}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-gray-600">Stake · Mult</p>
          <p className="font-mono text-white font-medium">{cycle.stake_usdc} USDC</p>
          <p className="text-xs text-gray-500">×{cycle.multiplier}</p>
        </div>
        <div>
          <p className="text-xs text-gray-600">Ensemble ajustado</p>
          <p className="font-mono text-white font-medium">
            {cycle.ensemble_adjusted != null ? `${cycle.ensemble_adjusted.toFixed(2)}°C` : '—'}
          </p>
          {cycle.bias_applied != null && (
            <p className="text-xs text-gray-500">
              N: {cycle.bias_applied >= 0 ? '+' : ''}{cycle.bias_applied.toFixed(2)}°C
            </p>
          )}
        </div>
      </div>

      {/* Botón Lanzar compra */}
      {isLive && cycle.status === 'open' && (
        <div className="space-y-1">
          <button
            onClick={handleLaunchOrder}
            disabled={buying}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
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

  const load = useCallback(async () => {
    setError(null)
    try {
      const [
        { data: st,  error: e1 },
        { data: cy,  error: e2 },
        { data: tmw, error: e3 },
      ] = await Promise.all([
        supabase.from('v_betting_status').select('*').maybeSingle(),
        supabase
          .from('betting_cycles')
          .select('id,target_date,stake_usdc,multiplier,token_a_temp,token_b_temp,actual_temp,status,pnl_usdc,simulated,capped_at_max')
          .order('target_date', { ascending: false })
          .limit(20),
        supabase
          .from('betting_cycles')
          .select(`
            id, target_date, stake_usdc, multiplier,
            token_a_temp, token_b_temp, status, simulated, prediction_id,
            predictions (
              ensemble_temp, ensemble_adjusted, bias_applied,
              cost_a_usdc, cost_b_usdc
            )
          `)
          .eq('target_date', tomorrowStr)
          .maybeSingle(),
      ])
      if (e1) throw new Error(e1.message)
      if (e2) throw new Error(e2.message)
      // e3: si no existe ciclo de mañana simplemente es null, no es error

      setStatus(st)
      setCycles(cy ?? [])

      if (tmw) {
        const pred = (tmw as any).predictions
        setTomorrowCycle({
          id:                tmw.id,
          target_date:       tmw.target_date,
          stake_usdc:        tmw.stake_usdc,
          multiplier:        tmw.multiplier,
          token_a_temp:      tmw.token_a_temp,
          token_b_temp:      tmw.token_b_temp,
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

  useEffect(() => {
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const channel = supabase
      .channel('betting-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'betting_cycles' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_config' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

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
    status?.max_stake && status?.base_stake ? status.max_stake / status.base_stake : null,
    1,
  )

  return (
    <div className="space-y-4">

      {/* ── Badge modo ── */}
      {status?.betting_mode && (
        <div className={`self-end inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs w-fit ml-auto ${
          status.betting_mode === 'live'
            ? 'bg-green-950 border-green-800 text-green-300'
            : 'bg-yellow-950 border-yellow-800 text-yellow-300'
        }`}>
          <span>{status.betting_mode === 'live' ? '🔴' : '🧪'}</span>
          <span className="font-medium">
            {status.betting_mode === 'live' ? 'Modo Real (live)' : 'Modo Simulado'}
          </span>
        </div>
      )}

      {/* ── KPIs globales ── */}
      {status && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Ciclos totales', value: status.total_cycles ?? '—' },
            { label: 'Hit rate',       value: status.hit_rate_pct != null ? `${status.hit_rate_pct}%` : '—' },
            { label: 'P&L total',
              value: status.total_pnl != null ? `${status.total_pnl >= 0 ? '+' : ''}${status.total_pnl} USDC` : '—',
              color: status.total_pnl != null ? pnlColor(status.total_pnl) : undefined },
            { label: 'Stake actual',   value: status.latest_stake != null ? `${status.latest_stake} USDC` : '—' },
            { label: 'Multiplicador',  value: status.current_multiplier != null ? `×${status.current_multiplier}` : '—' },
          ].map(kpi => (
            <div key={kpi.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-600 mb-1">{kpi.label}</p>
              <p className={`text-lg font-mono font-semibold ${(kpi as any).color ?? 'text-white'}`}>
                {kpi.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Barra Martingala ── */}
      {bar && status && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-gray-500">
              Martingala — {status.consecutive_losses ?? 0} pérdida(s) consecutiva(s)
            </p>
            <p className="text-xs text-gray-500 font-mono">
              {status.latest_stake ?? '—'} / {status.max_stake ?? '—'} USDC
            </p>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div className={`h-1.5 rounded-full transition-all ${bar.color}`} style={{ width: `${bar.pct}%` }} />
          </div>
        </div>
      )}

      {/* ── Ciclo de MAÑANA ── */}
      {tomorrowCycle ? (
        <TomorrowCyclePanel cycle={tomorrowCycle} onRefresh={load} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Ciclo de mañana</p>
            <p className="text-gray-600 text-sm">Sin ciclo creado para {tomorrowStr}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              onClick={handleRetryCycle}
              disabled={retrying}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                retrying
                  ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-blue-600 hover:text-blue-400 cursor-pointer'
              }`}
            >
              <span className={retrying ? 'animate-spin inline-block' : ''}>🔁</span>
              {retrying ? 'Solicitando…' : 'Relanzar ciclo'}
            </button>
            {retryMsg && (
              <p className={`text-[10px] ${retryMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
                {retryMsg.ok ? '✅' : '❌'} {retryMsg.text}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Último ciclo cerrado ── */}
      {status?.latest_date && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Último ciclo</p>
            <div className="flex items-center gap-2">
              {status.simulated && (
                <span className="text-[10px] text-yellow-600 border border-yellow-900 bg-yellow-950/30 rounded px-1.5 py-0.5">
                  simulado
                </span>
              )}
              <span className={`text-xs px-2 py-0.5 rounded border ${statusBadge(status.latest_status)}`}>
                {statusLabel(status.latest_status)}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-600">Fecha objetivo</p>
              <p className="font-mono text-white font-medium">
                {format(parseISO(status.latest_date), 'dd MMM yyyy', { locale: es })}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Token A / B</p>
              <p className="font-mono text-white font-medium">
                {status.token_a_temp ?? '—'}°C / {status.token_b_temp ?? '—'}°C
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Temp real</p>
              <p className={`font-mono font-medium ${status.actual_temp != null ? 'text-white' : 'text-gray-600'}`}>
                {status.actual_temp != null ? `${status.actual_temp}°C` : 'pendiente'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-600">P&L ciclo</p>
              <p className={`font-mono font-bold ${pnlColor(status.latest_pnl)}`}>
                {status.latest_pnl != null
                  ? `${status.latest_pnl >= 0 ? '+' : ''}${status.latest_pnl.toFixed(4)} USDC`
                  : '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Historial de ciclos ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Historial de ciclos
          </p>
          <div className="flex items-center gap-3">
            {cycles.length > 0 && (
              <span className="text-xs text-gray-600">{cycles.length} ciclo(s)</span>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Fecha', 'Stake', '×Mult', 'Tokens', 'Temp Real', 'P&L', 'Estado'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs text-gray-600 font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cycles.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-600 text-xs">
                    <p className="text-xl mb-1">📋</p>
                    Sin ciclos registrados todavía
                  </td>
                </tr>
              ) : cycles.map(c => (
                <tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5 text-gray-300 font-mono text-xs whitespace-nowrap">
                    {format(parseISO(c.target_date), 'dd/MM/yy')}
                  </td>
                  <td className="px-4 py-2.5 text-white font-mono text-xs">
                    {c.stake_usdc} USDC
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono">
                    <span className={c.capped_at_max ? 'text-red-400' : 'text-gray-400'}>
                      ×{c.multiplier}
                      {c.capped_at_max && <span className="ml-1 text-red-600">⚠</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 font-mono text-xs whitespace-nowrap">
                    {c.token_a_temp}°C / {c.token_b_temp}°C
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    <span className={c.actual_temp != null ? 'text-white' : 'text-gray-600'}>
                      {c.actual_temp != null ? `${c.actual_temp}°C` : '—'}
                    </span>
                  </td>
                  <td className={`px-4 py-2.5 font-mono text-xs font-semibold ${pnlColor(c.pnl_usdc)}`}>
                    {c.pnl_usdc != null
                      ? `${c.pnl_usdc >= 0 ? '+' : ''}${c.pnl_usdc.toFixed(4)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded border ${statusBadge(c.status)}`}>
                      {statusLabel(c.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}
