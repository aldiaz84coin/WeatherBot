// packages/dashboard/app/betting/page.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Página del Motor de Apuestas — /betting
// Muestra el estado del motor, historial de ciclos y log de eventos en vivo.
// El badge de modo (simulado/live) se renderiza en BettingEngine con datos reales.
// ──────────────────────────────────────────────────────────────────────────────

import { BettingEngine }  from '../../components/BettingEngine'
import { BotEventLog }    from '../../components/BotEventLog'
import { ManualBuyPanel } from '../../components/ManualBuyPanel'

export const revalidate = 30

export default function BettingPage() {
  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white">Motor de Apuestas</h1>
        <p className="text-gray-400 text-sm mt-1">
          Lógica Martingala · Ejecuta a las 00:30 Madrid
        </p>
      </div>

      {/* Motor de apuestas (KPIs + ciclo actual + historial + badge modo) */}
      <BettingEngine />

      {/* Compra manual — fuera del ciclo automático, con debug Polymarket */}
      <ManualBuyPanel />

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
