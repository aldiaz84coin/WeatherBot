// packages/dashboard/components/WeightsBiasPanel.tsx
// Panel informativo de solo lectura que muestra la configuración de pesos
// del ensemble y el bias N aplicado por el bot en cada operación.
// Se usa en Overview y Predicciones para tener visibilidad de qué config
// estaba activa cuando se ejecutó cada ciclo.

interface WeightEntry {
  slug:       string
  name:       string
  weight:     number
  updated_at?: string | null
}

interface WeightsBiasPanelProps {
  weights:   WeightEntry[]
  biasN:     number | null
  updatedAt: string | null
}

const SLUG_SHORT: Record<string, string> = {
  'open-meteo':      'OM',
  'aemet':           'AEM',
  'visual-crossing': 'VCR',
  'weatherapi':      'WAP',
  'openweathermap':  'OWM',
  'tomorrow-io':     'TMR',
  'accuweather':     'ACU',
}

function shortName(slug: string): string {
  return SLUG_SHORT[slug] ?? slug.toUpperCase().slice(0, 3)
}

function weightColor(w: number): string {
  if (w >= 0.25) return 'bg-blue-900 border-blue-700 text-blue-200'
  if (w >= 0.15) return 'bg-gray-800 border-gray-600 text-gray-200'
  return 'bg-gray-900 border-gray-700 text-gray-500'
}

function biasStyle(n: number | null) {
  if (n === null) return 'bg-gray-800 border-gray-700 text-gray-500'
  if (n > 0.3)   return 'bg-orange-950 border-orange-800 text-orange-300'
  if (n < -0.3)  return 'bg-blue-950 border-blue-800 text-blue-300'
  return 'bg-gray-800 border-gray-700 text-gray-400'
}

export function WeightsBiasPanel({ weights, biasN, updatedAt }: WeightsBiasPanelProps) {
  const sorted = [...weights].sort((a, b) => b.weight - a.weight)

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
          ⚙️ Configuración activa del bot
        </p>
        {updatedAt && (
          <span className="text-[10px] text-gray-700">
            actualizado {new Date(updatedAt).toLocaleDateString('es-ES', {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {/* Pesos por fuente */}
        {sorted.map(w => (
          <div
            key={w.slug}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 border text-xs ${weightColor(w.weight)}`}
            title={w.name}
          >
            <span className="font-mono text-[10px] opacity-70">{shortName(w.slug)}</span>
            <span className="font-semibold tabular-nums">{Math.round(w.weight * 100)}%</span>
          </div>
        ))}

        {/* Separador */}
        {weights.length > 0 && (
          <span className="text-gray-700 text-sm select-none">·</span>
        )}

        {/* Bias N */}
        <div className={`flex items-center gap-1.5 rounded-md px-2 py-1 border text-xs ${biasStyle(biasN)}`}>
          <span className="font-mono text-[10px] opacity-70">bias N</span>
          <span className="font-semibold tabular-nums">
            {biasN !== null
              ? `${biasN >= 0 ? '+' : ''}${biasN.toFixed(2)}°C`
              : '—'
            }
          </span>
        </div>
      </div>

      {weights.length === 0 && biasN === null && (
        <p className="text-xs text-gray-600 mt-1">
          Sin datos de configuración disponibles aún.
        </p>
      )}
    </section>
  )
}
