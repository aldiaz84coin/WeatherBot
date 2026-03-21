// components/PnlChart.tsx
'use client'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts'
import type { DailySummary } from '../lib/supabase'
import { format, parseISO } from 'date-fns'

interface Props { summaries: DailySummary[] }

export function PnlChart({ summaries }: Props) {
  // Construir curva de P&L acumulado (solo días resueltos)
  let cumulative = 0
  const data = [...summaries]
    .filter(s => s.pnl_net_usdc !== null)
    .reverse()
    .map(s => {
      cumulative += s.pnl_net_usdc ?? 0
      return {
        date: format(parseISO(s.target_date), 'dd/MM'),
        pnl: parseFloat(cumulative.toFixed(4)),
        daily: parseFloat((s.pnl_net_usdc ?? 0).toFixed(4)),
        won: s.won,
      }
    })

  if (!data.length) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-600 text-sm">
        Sin datos de resultados todavía
      </div>
    )
  }

  const isPositive = data[data.length - 1]?.pnl >= 0

  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.15} />
              <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v > 0 ? '+' : ''}${v}`}
          />
          <Tooltip
            contentStyle={{
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: '#9ca3af' }}
            formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v} USDC`, 'P&L acum.']}
          />
          <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="pnl"
            stroke={isPositive ? '#22c55e' : '#ef4444'}
            strokeWidth={1.5}
            fill="url(#pnlGrad)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
