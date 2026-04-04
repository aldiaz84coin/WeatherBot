'use client'
// packages/dashboard/components/BotConfigPanel.tsx
//
// FIX #1: Al montar, hace fetch real a GET /api/bot-config para leer el modo
// actual desde Supabase, ignorando el initialMode SSR que puede estar stale
// (config/page.tsx tiene revalidate=30, así que el prop puede mostrar simulación
// aunque el bot ya esté en live).

import { useState, useEffect, useCallback } from 'react'

type Mode = 'simulated' | 'live'

interface Props {
  initialMode:      Mode
  initialBaseStake: number
  initialMaxStake:  number
}

function buildLadder(base: number, max: number): { mult: number; stake: number }[] {
  const steps: { mult: number; stake: number }[] = []
  let mult = 1
  while (true) {
    const stake = Math.min(base * mult, max)
    steps.push({ mult, stake })
    if (stake >= max) break
    mult *= 2
    if (mult > 128) break // safety
  }
  return steps
}

export function BotConfigPanel({ initialMode, initialBaseStake, initialMaxStake }: Props) {
  const [mode,       setMode]       = useState<Mode>(initialMode)
  const [baseStake,  setBaseStake]  = useState(initialBaseStake)
  const [maxStake,   setMaxStake]   = useState(initialMaxStake)
  const [saving,     setSaving]     = useState(false)
  const [msg,        setMsg]        = useState<{ ok: boolean; text: string } | null>(null)
  const [confirm,    setConfirm]    = useState<Mode | null>(null)
  const [loadingCfg, setLoadingCfg] = useState(true)

  // ── FIX: carga el modo real desde Supabase al montar ─────────────────────
  const refreshConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/bot-config')
      if (!res.ok) return
      const { data } = await res.json()
      if (!Array.isArray(data)) return

      const modeRow  = data.find((r: any) => r.key === 'betting_mode')
      const baseRow  = data.find((r: any) => r.key === 'base_stake_usdc')
      const maxRow   = data.find((r: any) => r.key === 'max_stake_usdc')

      if (modeRow?.value) setMode(modeRow.value === 'live' ? 'live' : 'simulated')
      if (baseRow?.value) setBaseStake(Number(baseRow.value))
      if (maxRow?.value)  setMaxStake(Number(maxRow.value))
    } catch {
      // silencioso — se mantiene el initialMode del SSR
    } finally {
      setLoadingCfg(false)
    }
  }, [])

  useEffect(() => {
    refreshConfig()
  }, [refreshConfig])

  // ── Guardar una key ────────────────────────────────────────────────────────
  const patch = useCallback(async (key: string, value: unknown): Promise<boolean> => {
    const res = await fetch('/api/bot-config', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key, value }),
    })
    return res.ok
  }, [])

  // ── Toggle de modo ─────────────────────────────────────────────────────────
  const handleModeChange = (newMode: Mode) => {
    if (newMode === mode) return
    setConfirm(newMode)
  }

  const confirmModeChange = async () => {
    if (!confirm) return
    setSaving(true)
    setMsg(null)
    const ok = await patch('betting_mode', confirm)
    if (ok) {
      setMode(confirm)
      setMsg({
        ok:   true,
        text: confirm === 'live'
          ? '🔴 Modo LIVE activado — el bot ejecutará la compra real en ≤30 s'
          : '🟡 Modo SIMULACIÓN activado',
      })
    } else {
      setMsg({ ok: false, text: 'Error actualizando modo' })
    }
    setConfirm(null)
    setSaving(false)
    setTimeout(() => setMsg(null), 6_000)
  }

  // ── Guardar stakes ────────────────────────────────────────────────────────
  const handleSaveStakes = async () => {
    setSaving(true)
    setMsg(null)
    const [okBase, okMax] = await Promise.all([
      patch('base_stake_usdc', baseStake),
      patch('max_stake_usdc',  maxStake),
    ])
    setSaving(false)
    if (okBase && okMax) {
      setMsg({ ok: true, text: '✅ Stakes guardados en Supabase' })
    } else {
      setMsg({ ok: false, text: 'Error guardando stakes' })
    }
    setTimeout(() => setMsg(null), 5_000)
  }

  const ladder = buildLadder(baseStake, maxStake)
  const isLive = mode === 'live'

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">⚙️ Configuración del bot</h2>
        {loadingCfg ? (
          <span className="text-xs text-gray-600 animate-pulse">Cargando modo real…</span>
        ) : (
          <span className={`text-xs px-2 py-0.5 rounded border font-medium ${
            isLive
              ? 'bg-green-950 text-green-400 border-green-800'
              : 'bg-yellow-950 text-yellow-500 border-yellow-900'
          }`}>
            {isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}
          </span>
        )}
      </div>

      {/* ── Toggle modo ── */}
      <div>
        <p className="text-xs text-gray-500 mb-2">Modo de operación</p>
        <div className="flex gap-2">
          {(['simulated', 'live'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              disabled={saving || loadingCfg}
              className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${
                mode === m
                  ? m === 'live'
                    ? 'bg-green-900 border-green-700 text-green-300'
                    : 'bg-yellow-950 border-yellow-800 text-yellow-400'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
              }`}
            >
              {m === 'live' ? '🔴 Live' : '🟡 Simulación'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Dialog confirmación ── */}
      {confirm && (
        <div className={`rounded-xl border p-4 space-y-3 ${
          confirm === 'live'
            ? 'bg-red-950/30 border-red-800'
            : 'bg-gray-800 border-gray-700'
        }`}>
          <p className="text-sm text-white font-medium">
            {confirm === 'live'
              ? '⚠️ Activar modo LIVE — se ejecutarán órdenes reales en Polymarket'
              : '¿Volver a modo simulación?'}
          </p>
          {confirm === 'live' && (
            <p className="text-xs text-red-300">
              El bot lanzará una compra real a 1× stake base en los próximos 30 s. Asegúrate de tener saldo suficiente.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={confirmModeChange}
              disabled={saving}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                confirm === 'live'
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
            >
              {saving ? 'Guardando…' : 'Confirmar'}
            </button>
            <button
              onClick={() => setConfirm(null)}
              className="px-4 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ── Stakes ── */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Stake base (USDC)</label>
          <input
            type="number"
            min={1}
            max={1000}
            step={1}
            value={baseStake}
            onChange={e => setBaseStake(Math.max(1, Number(e.target.value)))}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-blue-600"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Stake máximo (USDC)</label>
          <input
            type="number"
            min={1}
            max={10000}
            step={1}
            value={maxStake}
            onChange={e => setMaxStake(Math.max(Number(baseStake), Number(e.target.value)))}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-blue-600"
          />
        </div>
      </div>

      <button
        onClick={handleSaveStakes}
        disabled={saving}
        className="w-full py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700
                   text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
      >
        {saving ? 'Guardando…' : 'Guardar stakes'}
      </button>

      {/* ── Escalera Martingala ── */}
      <div>
        <p className="text-xs text-gray-500 mb-2">Escalera Martingala</p>
        <div className="flex flex-wrap gap-1.5">
          {ladder.map((step, i) => (
            <div
              key={i}
              className={`text-xs px-2 py-1 rounded border font-mono ${
                step.stake >= maxStake
                  ? 'bg-red-950/40 border-red-900 text-red-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400'
              }`}
            >
              ×{step.mult} → {step.stake} USDC
            </div>
          ))}
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          {ladder.length} nivel{ladder.length !== 1 ? 'es' : ''} · tope en {maxStake} USDC
        </p>
      </div>

      {/* ── Mensaje de feedback ── */}
      {msg && (
        <p className={`text-xs text-center font-medium ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>
          {msg.text}
        </p>
      )}
    </section>
  )
}
