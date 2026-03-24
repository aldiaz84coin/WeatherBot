// packages/dashboard/app/betting/page.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Página del Motor de Apuestas — /betting
// Muestra el estado del motor, historial de ciclos y log de eventos en vivo.
// ──────────────────────────────────────────────────────────────────────────────

import { BettingEngine } from '../../components/BettingEngine'
import { BotEventLog }   from '../../components/BotEventLog'

export const revalidate = 30

export default function BettingPage() {
  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Motor de Apuestas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Lógica Martingala simulada · Ejecuta a las 00:30 Madrid
          </p>
        </div>

        {/* Badge modo simulado */}
        <div className="bg-yellow-950 border border-yellow-800 rounded-lg px-3 py-2 text-xs text-yellow-300">
          <p className="font-medium">Modo Simulado</p>
          <p className="text-yellow-600 mt-0.5">Cambia betting_mode → live en bot_config</p>
        </div>
      </div>

      {/* Motor de apuestas (KPIs + ciclo actual + historial) */}
      <BettingEngine />

      {/* Log de eventos del bot en tiempo real */}
      <div>
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
          📋 Log Operacional — Tiempo Real
        </h2>
        <BotEventLog limit={80} autoScroll />
      </div>

    </div>
  )
}
