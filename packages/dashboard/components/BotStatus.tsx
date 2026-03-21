// components/BotStatus.tsx
'use client'
import type { TrainingRun } from '../lib/supabase'

interface Props {
  isLive: boolean
  latestRun: TrainingRun | null
}

export function BotStatus({ isLive, latestRun }: Props) {
  const ready = latestRun?.passed ?? false

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-500 animate-pulse' : 'bg-yellow-500'}`} />
        <span className="text-xs font-medium text-gray-300">
          {isLive ? 'LIVE' : 'SIMULACIÓN'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${ready ? 'bg-green-500' : 'bg-gray-600'}`} />
        <span className="text-xs text-gray-500">
          {ready ? 'Entrenamiento OK' : 'Pendiente validación'}
        </span>
      </div>
    </div>
  )
}
