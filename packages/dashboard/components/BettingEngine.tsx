'use client'
// packages/dashboard/components/BettingEngine.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Panel completo del Motor de Apuestas Martingala.
// Muestra: estado actual, stake, ciclos históricos y configuración.
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
  id:              string
  target_date:     string
  stake_usdc:      number
  multiplier:      number
  token_a_temp:    number
  token_b_temp:    number
  actual_temp:     number | null
  status:          string
  pnl_usdc:        number | null
  simulated:       boolean
  capped_at_max:   boolean
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
  const pct = Math.min((Math.log2(mult) / Math.log2(max / base)) * 100, 100)
  const color = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-blue-500'
  return { pct, color }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function BettingEngine() {
  const [status, setStatus]   = useState<BettingStatus | null>(null)
  const [cycles, setCycles]   = useState<BettingCycle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [{ data: st }, { data: cy }] = await Promise.all([
        supabase.from('v_betting_status').select('*').maybeSingle(),
        supabase.from('betting_cycles')
          .select('id,target_date,stake_usdc,multiplier,token_a_temp,token_b_temp,actual_temp,status,pnl_usdc,simulated,capped_at_max')
          .order('target_date', { ascending: false })
          .limit(20),
      ])
      setStatus(st)
      setCycles(cy ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 60_000)  // refresco cada minuto
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
  if (loading && !status) {
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

  const bar = multiplierBar(
    status?.current_multiplier,
    status?.max_stake && status?.base_stake ? status.max_stake / status.base_stake : null,
    1
  )

  return (
    <section className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-gray-300">🎯 Motor de Apuestas — Martingala</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium
            ${status?.betting_mode === 'live'
              ? 'bg-red-950 text-red-400 border-red-800'
              : 'bg-yellow-950 text-yellow-400 border-yellow-800'}`}>
            {status?.betting_mode === 'live' ? '🔴 LIVE' : '🟡 SIMULADO'}
          </span>
        </div>
        <button
          onClick={load}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
        >
          ↺ actualizar
        </button>
      </div>

      {/* ── KPIs superiores ── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Hit Rate',      value: status?.hit_rate_pct != null ? `${status.hit_rate_pct}%` : '—',
            sub: 'objetivo ≥ 90%',  ok: (status?.hit_rate_pct ?? 0) >= 90 },
          { label: 'Ciclos',        value: String(status?.total_cycles ?? '—'),
            sub: `${status?.won_cycles ?? 0}W / ${status?.lost_cycles ?? 0}L` },
          { label: 'P&L Total',     value: status?.total_pnl != null
              ? `${Number(status.total_pnl) >= 0 ? '+' : ''}${Number(status.total_pnl).toFixed(2)} USDC`
              : '—',
            positive: (status?.total_pnl ?? 0) >= 0 },
          { label: 'Stake Actual',  value: status?.latest_stake != null ? `${status.latest_stake} USDC` : '—',
            sub: `× ${status?.current_multiplier ?? 1} (base: ${status?.base_stake ?? '—'} USDC)` },
          { label: 'Pérdidas racha',value: String(status?.consecutive_losses ?? 0),
            sub: `máx stake: ${status?.max_stake ?? '—'} USDC`,
            warn: (status?.consecutive_losses ?? 0) >= 3 },
        ].map((kpi, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{kpi.label}</p>
            <p className={`text-lg font-bold ${
              kpi.warn ? 'text-orange-400'
              : kpi.ok  ? 'text-green-400'
              : kpi.positive === true ? 'text-green-400'
              : kpi.positive === false ? 'text-red-400'
              : 'text-white'
            }`}>
              {kpi.value}
            </p>
            {kpi.sub && <p className="text-xs text-gray-600 mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* ── Barra Martingala ── */}
      {bar && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400">Nivel Martingala</p>
            <p className="text-xs text-gray-500">
              {status?.current_multiplier}× — {status?.latest_stake} USDC
              {status?.current_multiplier === 1 ? ' (base)' : ''}
              {(status?.latest_stake ?? 0) >= (status?.max_stake ?? Infinity) ? ' ⚠️ TOPE' : ''}
            </p>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${bar.color}`}
              style={{ width: `${bar.pct}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-gray-600">
            <span>{status?.base_stake} USDC (×1)</span>
            <span>{status?.max_stake} USDC (máx)</span>
          </div>
        </div>
      )}

      {/* ── Ciclo actual ── */}
      {status?.latest_date && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">
              Ciclo actual — {format(parseISO(status.latest_date), 'dd MMM yyyy', { locale: es })}
            </p>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusBadge(status.latest_status)}`}>
              {statusLabel(status.latest_status)}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
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
              <p className="text-xs text-gray-600">Temp real</p>
              <p className={`font-mono font-medium ${
                status.actual_temp != null ? 'text-white' : 'text-gray-600'
              }`}>
                {status.actual_temp != null ? `${status.actual_temp}°C` : 'pendiente'}
              </p>
            </div>
          </div>

          {status.latest_pnl != null && (
            <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
              <p className="text-xs text-gray-500">P&L del ciclo</p>
              <p className={`font-mono font-bold ${pnlColor(status.latest_pnl)}`}>
                {status.latest_pnl >= 0 ? '+' : ''}{status.latest_pnl.toFixed(4)} USDC
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Historial de ciclos ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Historial de ciclos
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Fecha','Stake','×Mult','Tokens','Temp Real','P&L','Estado'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs text-gray-600 font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cycles.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-600 text-xs">
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
                    <span className={c.capped_at_max ? 'text-orange-400' : 'text-gray-400'}>
                      ×{c.multiplier}
                      {c.capped_at_max && ' ⚠️'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-blue-300">
                    {c.token_a_temp}°C / {c.token_b_temp}°C
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-gray-400">
                    {c.actual_temp != null ? `${c.actual_temp}°C` : '—'}
                  </td>
                  <td className={`px-4 py-2.5 text-xs font-mono font-medium ${pnlColor(c.pnl_usdc)}`}>
                    {c.pnl_usdc != null
                      ? `${c.pnl_usdc >= 0 ? '+' : ''}${c.pnl_usdc.toFixed(4)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusBadge(c.status)}`}>
                      {statusLabel(c.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </section>
  )
}
