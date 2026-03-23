'use client'
// components/TrainingResults.tsx
import { useState } from 'react'
import type { DailySummary, TradeDetail } from '../lib/supabase'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

interface Props { summaries: DailySummary[] }

// Determina si la fila usa el modelo nuevo (token_a / token_b)
function isTwoTokenModel(s: DailySummary): boolean {
  return s.token_a != null || s.token_b != null
}

// Etiqueta legible para cada posición
function positionLabel(position: string): string {
  const labels: Record<string, string> = {
    a: 'Token A', b: 'Token B',
    low: 'Low', mid: 'Mid', high: 'High',
  }
  return labels[position] ?? position.toUpperCase()
}

// Icono de posición
function positionBadge(position: string) {
  const styles: Record<string, string> = {
    a:    'bg-violet-900/60 text-violet-300 border-violet-700',
    b:    'bg-blue-900/60 text-blue-300 border-blue-700',
    low:  'bg-gray-800 text-gray-300 border-gray-600',
    mid:  'bg-yellow-900/60 text-yellow-300 border-yellow-700',
    high: 'bg-orange-900/60 text-orange-300 border-orange-700',
  }
  return styles[position] ?? 'bg-gray-800 text-gray-400 border-gray-600'
}

// Formatea la hora de adquisición
function formatTime(isoString: string | null): string {
  if (!isoString) return '—'
  try {
    return format(parseISO(isoString), 'HH:mm', { locale: es })
  } catch {
    return '—'
  }
}

// Formatea fecha + hora completa para tooltip
function formatDateTime(isoString: string | null): string {
  if (!isoString) return '—'
  try {
    return format(parseISO(isoString), "dd MMM yyyy 'a las' HH:mm", { locale: es })
  } catch {
    return isoString
  }
}

// Panel expandible con detalle de trades
function TradeDetailPanel({ trades, predicted_at }: { trades: TradeDetail[]; predicted_at: string | null }) {
  // Usar el created_at del primer trade como hora de adquisición (o predicted_at como fallback)
  const acquisitionTime = trades[0]?.created_at ?? predicted_at

  return (
    <div className="px-4 py-3 bg-gray-950/80 border-t border-gray-800/60">
      {/* Hora de adquisición */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest font-medium">
          Adquisición
        </span>
        <span className="text-xs text-gray-400" title={formatDateTime(acquisitionTime)}>
          {formatDateTime(acquisitionTime)}
        </span>
      </div>

      {/* Grid de tokens */}
      <div className="flex flex-wrap gap-2">
        {trades.map((trade, idx) => (
          <div
            key={idx}
            className={`flex items-stretch gap-0 rounded-lg border overflow-hidden text-xs ${positionBadge(trade.position)}`}
          >
            {/* Etiqueta posición */}
            <div className={`flex items-center px-2.5 py-1.5 font-semibold text-[10px] tracking-wide uppercase border-r ${positionBadge(trade.position)} border-opacity-60`}>
              {positionLabel(trade.position)}
            </div>

            {/* Temperatura */}
            <div className="flex flex-col items-center justify-center px-3 py-1.5 bg-gray-900/60 border-r border-gray-700/40">
              <span className="text-[9px] text-gray-500 leading-none mb-0.5">Temp</span>
              <span className="font-bold text-white leading-none">{trade.token_temp}°C</span>
            </div>

            {/* Nº tokens (shares) */}
            <div className="flex flex-col items-center justify-center px-3 py-1.5 bg-gray-900/60 border-r border-gray-700/40">
              <span className="text-[9px] text-gray-500 leading-none mb-0.5">Tokens</span>
              <span className="font-bold text-white leading-none tabular-nums">
                {trade.shares != null ? trade.shares.toFixed(2) : '—'}
              </span>
            </div>

            {/* Precio por token */}
            <div className="flex flex-col items-center justify-center px-3 py-1.5 bg-gray-900/60 border-r border-gray-700/40">
              <span className="text-[9px] text-gray-500 leading-none mb-0.5">Precio</span>
              <span className="font-bold text-white leading-none tabular-nums">
                {trade.price_at_buy != null
                  ? `${(trade.price_at_buy * 100).toFixed(1)}¢`
                  : '—'}
              </span>
            </div>

            {/* Coste total del trade */}
            <div className="flex flex-col items-center justify-center px-3 py-1.5 bg-gray-900/60">
              <span className="text-[9px] text-gray-500 leading-none mb-0.5">Coste</span>
              <span className="font-semibold text-gray-300 leading-none tabular-nums">
                ${trade.cost_usdc.toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TrainingResults({ summaries }: Props) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  const toggleRow = (date: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  if (!summaries.length) {
    return <p className="text-gray-600 text-sm text-center py-8">Sin predicciones todavía</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left py-2 pr-4 font-normal">Fecha</th>
            <th className="text-right py-2 pr-4 font-normal">Predicción</th>
            <th className="text-right py-2 pr-4 font-normal">Tokens</th>
            <th className="text-right py-2 pr-4 font-normal">Cuantía</th>
            <th className="text-right py-2 pr-4 font-normal">Real</th>
            <th className="text-right py-2 pr-4 font-normal">Resultado</th>
            <th className="text-right py-2 font-normal">P&L</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => {
            const dateStr  = format(parseISO(s.target_date), 'dd MMM', { locale: es })
            const pnl      = s.pnl_net_usdc
            const pending  = s.actual_temp === null
            const twoToken = isTwoTokenModel(s)
            const hasTrades = s.trades && s.trades.length > 0
            const isExpanded = expandedRows.has(s.target_date)

            // Hora de adquisición resumida (para la celda de fecha)
            const acqTime = formatTime(s.trades?.[0]?.created_at ?? s.predicted_at)

            // ── Columna Tokens ───────────────────────────────────────────
            const tokensCell = twoToken ? (
              <span className="font-mono">
                {s.token_a != null ? `${s.token_a}°` : '—'}
                <span className="text-gray-600 mx-0.5">/</span>
                {s.token_b != null ? `${s.token_b}°` : '—'}
              </span>
            ) : (
              <span className="font-mono">
                {s.token_low  != null ? `${s.token_low}°`  : '—'}
                <span className="text-gray-600 mx-0.5">/</span>
                {s.token_mid  != null ? `${s.token_mid}°`  : '—'}
                <span className="text-gray-600 mx-0.5">/</span>
                {s.token_high != null ? `${s.token_high}°` : '—'}
              </span>
            )

            // ── Columna Cuantía ──────────────────────────────────────────
            const cuantiaCell = twoToken ? (
              s.cost_a_usdc != null && s.cost_b_usdc != null ? (
                <span className="font-mono text-gray-300">
                  ${s.cost_a_usdc.toFixed(2)}
                  <span className="text-gray-600 mx-0.5">+</span>
                  ${s.cost_b_usdc.toFixed(2)}
                </span>
              ) : s.stake_usdc != null ? (
                <span className="font-mono text-gray-300">${s.stake_usdc.toFixed(2)}</span>
              ) : (
                <span className="text-gray-600">—</span>
              )
            ) : (
              s.total_cost_usdc != null ? (
                <span className="font-mono text-gray-300">${s.total_cost_usdc.toFixed(2)}</span>
              ) : (
                <span className="text-gray-600">—</span>
              )
            )

            return (
              <>
                <tr
                  key={s.target_date}
                  onClick={() => hasTrades && toggleRow(s.target_date)}
                  className={`border-b border-gray-800/50 transition-colors ${
                    hasTrades
                      ? 'cursor-pointer hover:bg-gray-800/40'
                      : 'hover:bg-gray-800/20'
                  } ${isExpanded ? 'bg-gray-800/30' : ''}`}
                >
                  {/* Fecha + hora de adquisición */}
                  <td className="py-2.5 pr-4">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-gray-300">{dateStr}</span>
                      {s.simulated && (
                        <span className="text-xs text-yellow-600 font-medium">SIM</span>
                      )}
                    </div>
                    {acqTime !== '—' && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[10px] text-gray-600">🕐 {acqTime}</span>
                      </div>
                    )}
                  </td>

                  {/* Predicción ensemble */}
                  <td className="py-2.5 pr-4 text-right text-white font-medium">
                    {s.ensemble_temp?.toFixed(1)}°C
                  </td>

                  {/* Tokens */}
                  <td className="py-2.5 pr-4 text-right text-gray-400 text-xs">
                    {tokensCell}
                  </td>

                  {/* Cuantía */}
                  <td className="py-2.5 pr-4 text-right text-xs">
                    {cuantiaCell}
                  </td>

                  {/* Temp real */}
                  <td className="py-2.5 pr-4 text-right">
                    {pending ? (
                      <span className="text-gray-600">—</span>
                    ) : (
                      <span className="text-gray-300">{s.actual_temp?.toFixed(1)}°C</span>
                    )}
                  </td>

                  {/* Resultado */}
                  <td className="py-2.5 pr-4 text-right">
                    {pending ? (
                      <span className="text-gray-600 text-xs">Pendiente</span>
                    ) : s.won ? (
                      <span className="text-green-400 text-xs font-medium">
                        ✓ {s.winning_position}
                      </span>
                    ) : (
                      <span className="text-red-400 text-xs font-medium">✗ Miss</span>
                    )}
                  </td>

                  {/* P&L + expand hint */}
                  <td className="py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className={`font-medium tabular-nums ${
                        pending
                          ? 'text-gray-600 text-xs'
                          : pnl != null
                            ? pnl >= 0 ? 'text-green-400' : 'text-red-400'
                            : 'text-gray-600'
                      }`}>
                        {pending
                          ? '—'
                          : pnl != null
                            ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
                            : '—'}
                      </span>
                      {hasTrades && (
                        <span className="text-gray-600 text-[10px] select-none">
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>

                {/* Fila expandible con detalle de trades */}
                {isExpanded && hasTrades && (
                  <tr key={`${s.target_date}-detail`} className="border-b border-gray-800/50">
                    <td colSpan={7} className="p-0">
                      <TradeDetailPanel
                        trades={s.trades!}
                        predicted_at={s.predicted_at}
                      />
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>

      {summaries.some(s => s.trades && s.trades.length > 0) && (
        <p className="text-[10px] text-gray-700 mt-2 text-right">
          Pulsa cualquier fila para ver el detalle de tokens adquiridos
        </p>
      )}
    </div>
  )
}
