'use client'
// packages/dashboard/components/BettingEngine.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Panel completo del Motor de Apuestas Martingala.
// Muestra: estado actual, stake, ciclos históricos y configuración.
//
// CORRECCIÓN:
//  5. Estado vacío informativo cuando v_betting_status devuelve 0 filas
//     (betting_cycles vacía → status=null no renderizaba nada sin explicación)
// ──────────────────────────────────────────────────────────────────────────────

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
  // Config
  base_stake:         number | null
  max_stake:          number | null
  current_multiplier: number | null
  consecutive_losses: number | null
  betting_mode:       string | null
  // KPIs
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

// ─── Helpers de estilo ────────────────────────────────────────────────────────

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

// ─── Empty state — primer ciclo todavía no ejecutado ─────────────────────────
// FIX #5: antes este bloque no existía y la sección de KPIs simplemente
// no renderizaba nada cuando betting_cycles estaba vacía, sin explicación.

function NoDataState() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col items-center justify-center text-center gap-3">
      <span className="text-3xl">🎯</span>
      <div>
        <p className="text-gray-300 font-medium text-sm">Sin ciclos registrados</p>
        <p className="text-gray-600 text-xs mt-1 max-w-xs">
          El motor ejecutará el primer ciclo a las <span className="text-gray-400">00:30 (Madrid)</span>.
          Mientras tanto puedes revisar la configuración en{' '}
          <span className="text-gray-400">bot_config</span>.
        </p>
      </div>
      <div className="flex gap-4 text-xs text-gray-700 mt-1">
        <span>base_stake_usdc</span>
        <span>·</span>
        <span>max_stake_usdc</span>
        <span>·</span>
        <span>betting_mode</span>
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function BettingEngine() {
  const [status, setStatus]       = useState<BettingStatus | null>(null)
  const [cycles, setCycles]       = useState<BettingCycle[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [retrying, setRetrying]   = useState(false)
  const [retryMsg, setRetryMsg]   = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [{ data: st, error: e1 }, { data: cy, error: e2 }] = await Promise.all([
        supabase.from('v_betting_status').select('*').maybeSingle(),
        supabase
          .from('betting_cycles')
          .select('id,target_date,stake_usdc,multiplier,token_a_temp,token_b_temp,actual_temp,status,pnl_usdc,simulated,capped_at_max')
          .order('target_date', { ascending: false })
          .limit(20),
      ])
      if (e1) throw new Error(e1.message)
      if (e2) throw new Error(e2.message)
      setStatus(st)
      setCycles(cy ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRetryCycle = useCallback(async () => {
    setRetrying(true)
    setRetryMsg(null)
    try {
      const res  = await fetch('/api/betting/retry-orders', { method: 'POST' })
      const data = await res.json()
      setRetryMsg(res.ok
        ? { ok: true,  text: data.message ?? 'Órdenes se reenviarán en ~30 s.' }
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

  // ─── Real-time subscription ───────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('betting-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'betting_cycles' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_config' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  // ─── Loading ──────────────────────────────────────────────────────────────
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

  // FIX #5: si no hay ningún ciclo todavía, mostrar estado vacío informativo
  if (!status && cycles.length === 0) {
    return <NoDataState />
  }

  const bar = multiplierBar(
    status?.current_multiplier ?? null,
    status?.max_stake && status?.base_stake
      ? status.max_stake / status.base_stake
      : null,
    1,
  )

  return (
    <div className="space-y-4">

      {/* ── Badge modo (dinámico desde bot_config) ── */}
      {status?.betting_mode && (
        <div className={`self-end inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs w-fit ml-auto ${
          status.betting_mode === 'live'
            ? 'bg-green-950 border-green-800 text-green-300'
            : 'bg-yellow-950 border-yellow-800 text-yellow-300'
        }`}>
          <span>{status.betting_mode === 'live' ? '🔴' : '🧪'}</span>
          <span className="font-medium">{status.betting_mode === 'live' ? 'Modo Real (live)' : 'Modo Simulado'}</span>
        </div>
      )}

      {/* ── KPIs globales ── */}
      {status && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Ciclos totales', value: status.total_cycles ?? '—', sub: null },
            { label: 'Hit rate',       value: status.hit_rate_pct != null ? `${status.hit_rate_pct}%` : '—', sub: null },
            { label: 'P&L total',      value: status.total_pnl != null ? `${status.total_pnl >= 0 ? '+' : ''}${status.total_pnl} USDC` : '—',
              color: status.total_pnl != null ? pnlColor(status.total_pnl) : undefined },
            { label: 'Stake actual',   value: status.latest_stake != null ? `${status.latest_stake} USDC` : '—', sub: null },
            { label: 'Multiplicador',  value: status.current_multiplier != null ? `×${status.current_multiplier}` : '—', sub: null },
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
            <div
              className={`h-1.5 rounded-full transition-all ${bar.color}`}
              style={{ width: `${bar.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Ciclo actual ── */}
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
                {status.latest_date
                  ? format(parseISO(status.latest_date), 'dd MMM yyyy', { locale: es })
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Token A</p>
              <p className="font-mono text-white font-medium">{status.token_a_temp ?? '—'}°C</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Token B</p>
              <p className="font-mono text-white font-medium">{status.token_b_temp ?? '—'}°C</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Shares</p>
              <p className="font-mono text-white font-medium">{status.shares?.toFixed(4) ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Coste A</p>
              <p className="font-mono text-gray-300 text-sm">{status.cost_a_usdc?.toFixed(4) ?? '—'} USDC</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Coste B</p>
              <p className="font-mono text-gray-300 text-sm">{status.cost_b_usdc?.toFixed(4) ?? '—'} USDC</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Temp real</p>
              <p className={`font-mono font-medium ${
                status.actual_temp != null ? 'text-white' : 'text-gray-600'
              }`}>
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
            <div className="flex flex-col items-end gap-1">
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
