// components/MarketDataPanel.tsx
// Panel para explorar los datos de mercado de Polymarket cacheados.
// Permite ver qué tokens existen para una fecha específica.
'use client'

import { useState } from 'react'
import { format, subDays } from 'date-fns'

interface Token {
  tempCelsius: number
  price: number
  resolvedYes: boolean
  resolved: boolean
}

interface DayMarkets {
  date: string
  available: boolean
  tokens: Token[]
  resolvedTemp: number | null
  totalPriceSum: number
}

export function MarketDataPanel() {
  const [date, setDate] = useState(format(subDays(new Date(), 2), 'yyyy-MM-dd'))
  const [markets, setMarkets] = useState<DayMarkets | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetch_ = async () => {
    setLoading(true)
    setError(null)
    setMarkets(null)

    try {
      const res = await fetch(`/api/markets?date=${date}`)
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? 'Error desconocido')
      }
      const data = await res.json()
      setMarkets(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-300 mb-4">
        Explorador de mercados Polymarket
      </h2>

      <div className="flex gap-3 mb-4">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                     focus:outline-none focus:border-blue-600"
        />
        <button
          onClick={fetch_}
          disabled={loading}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg
                     transition-colors disabled:opacity-50"
        >
          {loading ? 'Buscando...' : 'Buscar tokens'}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-400 text-sm mb-3">
          {error}
        </div>
      )}

      {markets && !markets.available && (
        <p className="text-gray-500 text-sm py-4 text-center">
          No hay mercados de Polymarket para {date}
        </p>
      )}

      {markets && markets.available && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500">
              {markets.tokens.length} tokens disponibles ·{' '}
              suma total de precios: <strong className="text-white">{markets.totalPriceSum}</strong>
            </p>
            {markets.resolvedTemp !== null && (
              <span className="text-xs px-2 py-1 bg-green-950 text-green-400 border border-green-800 rounded-full">
                ✅ Resuelto a {markets.resolvedTemp}°C
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {markets.tokens.map(t => (
              <div
                key={t.tempCelsius}
                className={`px-3 py-2 rounded-lg border text-center ${
                  t.resolvedYes
                    ? 'bg-green-950 border-green-700 text-green-300'
                    : t.resolved
                      ? 'bg-gray-900 border-gray-700 text-gray-600'
                      : 'bg-gray-950 border-gray-700 text-gray-300'
                }`}
              >
                <p className="text-sm font-medium">{t.tempCelsius}°C</p>
                <p className="text-xs mt-0.5 opacity-70">
                  {(t.price * 100).toFixed(0)}¢
                </p>
                {t.resolvedYes && <p className="text-xs mt-0.5">✓ WIN</p>}
              </div>
            ))}
          </div>

          {/* Simulación rápida */}
          <div className="mt-4 pt-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              Si compras los tokens con suma &lt; 0.80 USDC centrados en{' '}
              {markets.tokens.find(t => Math.abs(t.price - 0.5) < 0.2)?.tempCelsius ?? '?'}°C,
              tu ganancia mínima garantizada sería{' '}
              <strong className="text-green-400">
                {markets.tokens.length > 0
                  ? `≥ ${(1 - 0.80).toFixed(2)} USDC`
                  : '—'}
              </strong>
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
