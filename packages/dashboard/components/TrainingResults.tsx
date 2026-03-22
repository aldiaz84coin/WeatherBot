// components/TrainingResults.tsx
import type { DailySummary } from '../lib/supabase'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

interface Props { summaries: DailySummary[] }

// Determina si la fila usa el modelo nuevo (token_a / token_b)
function isTwoTokenModel(s: DailySummary): boolean {
  return s.token_a != null || s.token_b != null
}

export function TrainingResults({ summaries }: Props) {
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
            const dateStr = format(parseISO(s.target_date), 'dd MMM', { locale: es })
            const pnl     = s.pnl_net_usdc
            const pending = s.actual_temp === null
            const twoToken = isTwoTokenModel(s)

            // ── Columna Tokens ───────────────────────────────────────────
            const tokensCell = twoToken ? (
              <span className="font-mono">
                {s.token_a != null ? `${s.token_a}°` : '—'}
                <span className="text-gray-600 mx-0.5">/</span>
                {s.token_b != null ? `${s.token_b}°` : '—'}
              </span>
            ) : (
              <span className="font-mono">
                {s.token_low != null  ? `${s.token_low}°`  : '—'}
                <span className="text-gray-600 mx-0.5">/</span>
                {s.token_mid != null  ? `${s.token_mid}°`  : '—'}
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
              <tr key={s.target_date} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">

                {/* Fecha */}
                <td className="py-2.5 pr-4 text-gray-300">
                  {dateStr}
                  {s.simulated && (
                    <span className="ml-1.5 text-xs text-yellow-600 font-medium">SIM</span>
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

                {/* P&L */}
                <td className="py-2.5 text-right font-medium tabular-nums">
                  {pending ? (
                    <span className="text-gray-600 text-xs">—</span>
                  ) : pnl != null ? (
                    <span className={pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
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
