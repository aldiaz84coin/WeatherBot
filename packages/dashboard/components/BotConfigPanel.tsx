'use client'

// packages/dashboard/components/BotConfigPanel.tsx
// Panel interactivo para controlar la configuración de apuestas del bot.
// Permite: cambiar modo simulated/live, y ajustar base_stake y max_stake.
// Escribe via PATCH /api/bot-config (que usa service key para bypass de RLS).

import { useState } from 'react'

interface BotConfigPanelProps {
  initialMode:      'simulated' | 'live'
  initialBaseStake: number
  initialMaxStake:  number
}

type SaveState = 'idle' | 'saving' | 'ok' | 'error'

async function patchConfig(key: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/bot-config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  const data = await res.json()
  return { ok: res.ok, error: data.error }
}

export function BotConfigPanel({
  initialMode,
  initialBaseStake,
  initialMaxStake,
}: BotConfigPanelProps) {
  const [mode, setMode]                 = useState<'simulated' | 'live'>(initialMode)
  const [baseStake, setBaseStake]       = useState<number>(initialBaseStake)
  const [maxStake, setMaxStake]         = useState<number>(initialMaxStake)
  const [confirmLive, setConfirmLive]   = useState(false)
  const [saveState, setSaveState]       = useState<SaveState>('idle')
  const [errorMsg, setErrorMsg]         = useState<string | null>(null)

  // ── Cambio de modo ──────────────────────────────────────────────────────────

  async function handleModeToggle(newMode: 'simulated' | 'live') {
    if (newMode === 'live' && !confirmLive) {
      setConfirmLive(true)
      return
    }
    setConfirmLive(false)
    setSaveState('saving')
    setErrorMsg(null)

    const { ok, error } = await patchConfig('betting_mode', newMode)
    if (ok) {
      setMode(newMode)
      setSaveState('ok')
      setTimeout(() => setSaveState('idle'), 2500)
    } else {
      setErrorMsg(error ?? 'Error al cambiar modo')
      setSaveState('error')
    }
  }

  // ── Guardar stakes ──────────────────────────────────────────────────────────

  async function handleSaveStakes() {
    if (baseStake <= 0 || maxStake <= 0) {
      setErrorMsg('Los valores de stake deben ser positivos')
      setSaveState('error')
      return
    }
    if (maxStake < baseStake) {
      setErrorMsg('El stake máximo debe ser ≥ stake base')
      setSaveState('error')
      return
    }

    setSaveState('saving')
    setErrorMsg(null)

    const [r1, r2] = await Promise.all([
      patchConfig('base_stake_usdc', baseStake),
      patchConfig('max_stake_usdc',  maxStake),
    ])

    if (r1.ok && r2.ok) {
      setSaveState('ok')
      setTimeout(() => setSaveState('idle'), 2500)
    } else {
      setErrorMsg(r1.error ?? r2.error ?? 'Error al guardar')
      setSaveState('error')
    }
  }

  const isSaving = saveState === 'saving'

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <h2 className="text-sm font-medium text-gray-300">🎛️ Control del bot</h2>

      {/* ── Modo simulated / live ─────────────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Modo de operación</p>

        <div className="flex gap-2 items-center">
          {/* Botón Simulado */}
          <button
            onClick={() => handleModeToggle('simulated')}
            disabled={isSaving || mode === 'simulated'}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
              mode === 'simulated'
                ? 'bg-yellow-950 border-yellow-700 text-yellow-300 cursor-default'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
            }`}
          >
            🧪 Simulado
          </button>

          {/* Separador */}
          <div className="flex-1 border-t border-gray-800" />

          {/* Botón Real */}
          <button
            onClick={() => handleModeToggle('live')}
            disabled={isSaving || mode === 'live'}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
              mode === 'live'
                ? 'bg-green-950 border-green-700 text-green-300 cursor-default'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-red-800 hover:text-red-300'
            }`}
          >
            🔴 Real (live)
          </button>
        </div>

        {/* Estado actual */}
        <p className="text-[11px] text-gray-600 mt-1.5">
          {mode === 'simulated'
            ? 'El bot simula operaciones sin enviar órdenes reales a Polymarket.'
            : '⚠️ El bot está enviando órdenes reales a Polymarket.'}
        </p>

        {/* Confirmación paso a live */}
        {confirmLive && (
          <div className="mt-3 bg-red-950/60 border border-red-800 rounded-lg p-3 space-y-2">
            <p className="text-sm text-red-300 font-medium">
              ⚠️ ¿Activar modo real?
            </p>
            <p className="text-xs text-red-400">
              A partir del próximo ciclo (00:30) el bot ejecutará órdenes reales en Polymarket.
              Asegúrate de tener fondos USDC en la wallet y las claves CLOB configuradas.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => handleModeToggle('live')}
                className="px-3 py-1.5 bg-red-800 hover:bg-red-700 text-red-100 text-xs font-medium rounded-md transition-colors"
              >
                Confirmar → modo real
              </button>
              <button
                onClick={() => setConfirmLive(false)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-md transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Stake base + máximo ───────────────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Configuración Martingala</p>

        <div className="grid grid-cols-2 gap-4">
          {/* Base */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Stake base (USDC)
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-600 text-sm">$</span>
              <input
                type="number"
                min={1}
                step={1}
                value={baseStake}
                onChange={e => setBaseStake(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-white
                           focus:outline-none focus:border-blue-600 tabular-nums"
              />
            </div>
            <p className="text-[10px] text-gray-600 mt-1">Importe por ciclo sin pérdidas</p>
          </div>

          {/* Máximo */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Stake máximo (USDC)
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-600 text-sm">$</span>
              <input
                type="number"
                min={baseStake}
                step={1}
                value={maxStake}
                onChange={e => setMaxStake(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-white
                           focus:outline-none focus:border-blue-600 tabular-nums"
              />
            </div>
            <p className="text-[10px] text-gray-600 mt-1">Tope Martingala (máx. ×{(maxStake / Math.max(baseStake, 1)).toFixed(0)} veces)</p>
          </div>
        </div>

        {/* Escalera Martingala */}
        <div className="mt-3 flex gap-1.5 flex-wrap">
          {Array.from({ length: Math.min(6, Math.ceil(Math.log2(maxStake / Math.max(baseStake, 1))) + 1) }, (_, i) => {
            const stake = Math.min(baseStake * Math.pow(2, i), maxStake)
            const capped = stake >= maxStake && i > 0
            return (
              <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums ${
                i === 0
                  ? 'bg-blue-950 border-blue-800 text-blue-300'
                  : capped
                  ? 'bg-red-950 border-red-900 text-red-400'
                  : 'bg-gray-800 border-gray-700 text-gray-500'
              }`}>
                ${stake.toFixed(0)}
              </span>
            )
          })}
        </div>
        <p className="text-[10px] text-gray-600 mt-1">Escalada de stakes si se pierde consecutivamente</p>

        {/* Botón guardar */}
        <button
          onClick={handleSaveStakes}
          disabled={isSaving}
          className={`mt-4 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isSaving
              ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
              : saveState === 'ok'
              ? 'bg-green-900 border border-green-700 text-green-300'
              : 'bg-blue-900 border border-blue-700 text-blue-300 hover:bg-blue-800'
          }`}
        >
          {isSaving        ? '⏳ Guardando...'
           : saveState === 'ok'   ? '✅ Guardado'
           : '💾 Guardar stakes'}
        </button>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {saveState === 'error' && errorMsg && (
        <div className="bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          <p className="text-xs text-red-400">{errorMsg}</p>
        </div>
      )}
    </section>
  )
}
