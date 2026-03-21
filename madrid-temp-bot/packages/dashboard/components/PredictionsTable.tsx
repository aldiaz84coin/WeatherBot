// components/PredictionsTable.tsx
import type { DailySummary } from '../lib/supabase'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

interface Props { summaries: DailySummary[] }

export function PredictionsTable({ summaries }: Props) {
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
            <th className="text-right py-2 pr-4 font-normal">Real</th>
            <th className="text-right py-2 pr-4 font-normal">Resultado</th>
            <th className="text-right py-2 font-normal">P&L</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => {
            const dateStr = format(parseISO(s.target_date), 'dd MMM', { locale: es })
            const pnl = s.pnl_net_usdc
            const pending = s.actual_temp === null

            return (
              <tr key={s.target_date} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                <td className="py-2.5 pr-4 text-gray-300">
                  {dateStr}
                  {s.simulated && (
                    <span className="ml-1.5 text-xs text-yellow-600 font-medium">SIM</span>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-right text-white font-medium">
                  {s.ensemble_temp?.toFixed(1)}°C
                </td>
                <td className="py-2.5 pr-4 text-right text-gray-400 text-xs">
                  [{s.token_low}° / {s.token_mid}° / {s.token_high}°]
                </td>
                <td className="py-2.5 pr-4 text-right">
                  {pending ? (
                    <span className="text-gray-600">—</span>
                  ) : (
                    <span className="text-gray-300">{s.actual_temp?.toFixed(1)}°C</span>
                  )}
                </td>
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
                <td className="py-2.5 text-right font-medium tabular-nums">
                  {pending ? (
                    <span className="text-gray-600">—</span>
                  ) : (
                    <span className={pnl !== null && pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {pnl !== null
                        ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`
                        : '—'}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
