'use client'
// components/PolymarketSimPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Panel de dos ventanas para la Fase 1 del entrenamiento:
//
//  · Izquierda — VENTANA DE APUESTAS
//    Slug del mercado de mañana + todos los tokens YES con precios actuales
//    directamente desde Gamma API (a través de /api/markets).
//
//  · Derecha — SIMULACIÓN PASADA
//    Últimos N días con la temperatura ganadora resuelta por Polymarket.
//    Permite validar que los slugs históricos resuelven correctamente y que
//    el backtest usa los precios y resultados reales.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react'
import { format, subDays, addDays } from 'date-fns'
import { es } from 'date-fns/locale'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface Token {
  tempCelsius: number
  price: number
  resolvedYes: boolean
  resolved: boolean
  slug?: string
}

interface DayMarkets {
  date: string
  available: boolean
  tokens: Token[]
  resolvedTemp: number | null
  totalPriceSum: number
  fromCache?: boolean
}

interface HistoryRow {
  date: string
  slug: string
  data: DayMarkets | null
  status: 'loading' | 'done' | 'error'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS_EN = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
]

function buildDaySlug(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return `highest-temperature-in-madrid-on-${MONTHS_EN[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}

function fmtShort(dateStr: string): string {
  return format(new Date(dateStr + 'T12:00:00'), 'EEE dd MMM', { locale: es })
}

function priceColor(price: number): string {
  if (price > 0.20) return 'text-emerald-400'
  if (price > 0.08) return 'text-yellow-400'
  return 'text-gray-500'
}

// ── Sub-componente: fila de token ─────────────────────────────────────────────

function TokenRow({ token, isTop, maxPrice }: { token: Token; isTop: boolean; maxPrice: number }) {
  const barPct = maxPrice > 0 ? ((token.price / maxPrice) * 100).toFixed(1) : '0'
  const barColor =
     token.tempCelsius >= 30 ? 'bg-gradient-to-r from-amber-500 to-red-500'
   : token.tempCelsius >= 22 ? 'bg-gradient-to-r from-emerald-500 to-blue-500'
    //token.tempC >= 30 ? 'bg-gradient-to-r from-amber-500 to-red-500'
    //: token.tempC >= 22 ? 'bg-gradient-to-r from-emerald-500 to-blue-500'
    : 'bg-blue-600'

  return (
    <tr className={`border-b border-gray-800/50 ${isTop ? 'bg-blue-950/20' : ''}`}>
      <td className="py-1.5 pr-3 font-mono text-sm font-semibold text-white">
        {token.tempCelsius}°C
        {isTop && <span className="ml-1.5 text-blue-400 text-xs">◀</span>}
      </td>
      <td className="py-1.5 pr-3 w-full">
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
      </td>
      <td className={`py-1.5 text-right font-mono text-sm font-medium tabular-nums ${priceColor(token.price)}`}>
        {(token.price * 100).toFixed(1)}¢
      </td>
    </tr>
  )
}

// ── Sub-componente: fila de historial ─────────────────────────────────────────

function HistRow({ row }: { row: HistoryRow }) {
  const shortSlug = row.slug.replace('highest-temperature-in-madrid-on-', '')
  const { data, status } = row

  if (status === 'loading') {
    return (
      <tr className="border-b border-gray-800/50 animate-pulse">
        <td className="py-2 pr-3 font-mono text-xs text-gray-500">{fmtShort(row.date)}</td>
        <td className="py-2 pr-3 font-mono text-xs text-gray-700">{shortSlug}</td>
        <td className="py-2 pr-3 text-center">
          <span className="text-gray-700 font-mono text-xs">—</span>
        </td>
        <td className="py-2 text-right">
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-600">…</span>
        </td>
      </tr>
    )
  }

  if (status === 'error' || !data) {
    return (
      <tr className="border-b border-gray-800/50">
        <td className="py-2 pr-3 font-mono text-xs text-gray-500">{fmtShort(row.date)}</td>
        <td className="py-2 pr-3 font-mono text-xs text-gray-700">{shortSlug}</td>
        <td className="py-2 pr-3 text-center"><span className="text-gray-600 text-xs">—</span></td>
        <td className="py-2 text-right">
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-red-950 text-red-500 border border-red-900">
            sin datos
          </span>
        </td>
      </tr>
    )
  }

  const resolved = data.resolvedTemp !== null
  const isOpen   = data.available && !resolved

  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
      <td className="py-2 pr-3 font-mono text-xs text-gray-400">{fmtShort(row.date)}</td>
      <td className="py-2 pr-3 font-mono text-xs text-gray-600 max-w-0 truncate" title={row.slug}>
        {shortSlug}
      </td>
      <td className="py-2 pr-3 text-center">
        {resolved ? (
          <span className="font-mono text-sm font-bold text-emerald-400">
            {data.resolvedTemp}°C
          </span>
        ) : isOpen ? (
          <span className="font-mono text-xs text-blue-400">abierto</span>
        ) : (
          <span className="text-gray-600 text-xs">—</span>
        )}
      </td>
      <td className="py-2 text-right">
        {resolved ? (
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900 font-medium">
            resuelto
          </span>
        ) : isOpen ? (
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-blue-950 text-blue-400 border border-blue-900">
            en curso
          </span>
        ) : (
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700">
            sin mercado
          </span>
        )}
      </td>
    </tr>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

const HISTORY_DAYS = 8

export function PolymarketSimPanel() {
  const today         = new Date()
  const tomorrowDate  = format(addDays(today, 1), 'yyyy-MM-dd')
  const tomorrowSlug  = buildDaySlug(tomorrowDate)

  // ── Estado ventana apuestas ──
  const [betData,    setBetData]    = useState<DayMarkets | null>(null)
  const [betLoading, setBetLoading] = useState(true)
  const [betError,   setBetError]   = useState<string | null>(null)

  // ── Estado historial ──
  const [histRows, setHistRows] = useState<HistoryRow[]>(() =>
    Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const d = format(subDays(today, i + 1), 'yyyy-MM-dd')
      return { date: d, slug: buildDaySlug(d), data: null, status: 'loading' as const }
    })
  )
  const [histResolved, setHistResolved] = useState(0)

  // ── Fetch mañana ──
  const loadTomorrow = useCallback(async () => {
    setBetLoading(true)
    setBetError(null)
    setBetData(null)
    try {
      const res = await fetch(`/api/markets?date=${tomorrowDate}`)
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? `HTTP ${res.status}`)
      }
      setBetData(await res.json())
    } catch (e) {
      setBetError((e as Error).message)
    } finally {
      setBetLoading(false)
    }
  }, [tomorrowDate])

  // ── Fetch historial concurrente ──
  const loadHistory = useCallback(async () => {
    const dates = Array.from({ length: HISTORY_DAYS }, (_, i) =>
      format(subDays(today, i + 1), 'yyyy-MM-dd')
    )

    // Reset a loading
    setHistRows(dates.map(d => ({
      date: d,
      slug: buildDaySlug(d),
      data: null,
      status: 'loading' as const,
    })))
    setHistResolved(0)

    // Fetch concurrente, actualizar fila cuando llega
    await Promise.allSettled(
      dates.map(async (dateStr, i) => {
        try {
          const res = await fetch(`/api/markets?date=${dateStr}`)
          const data: DayMarkets = res.ok ? await res.json() : null
          setHistRows(prev => {
            const next = [...prev]
            next[i] = { ...next[i], data, status: 'done' }
            return next
          })
          if (data?.resolvedTemp !== null && data?.resolvedTemp !== undefined) {
            setHistResolved(n => n + 1)
          }
        } catch {
          setHistRows(prev => {
            const next = [...prev]
            next[i] = { ...next[i], status: 'error' }
            return next
          })
        }
      })
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadTomorrow()
    loadHistory()
  }, [loadTomorrow, loadHistory])

  // ── Derived: ventana apuestas ──
  const tokens    = betData?.tokens ?? []
  const topToken  = tokens.length > 0
    ? tokens.reduce((a, b) => (b.price > a.price ? b : a), tokens[0])
    : null
  const maxPrice  = tokens.length > 0 ? Math.max(...tokens.map(t => t.price)) : 1
  const totalProb = tokens.reduce((s, t) => s + t.price, 0)

  // ── Derived: historial ──
  const withMarket = histRows.filter(r => r.data?.available).length

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-gray-900/80">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <h2 className="text-sm font-medium text-gray-200">
            Polymarket · Fase 1 — Ventanas de simulación
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadTomorrow}
            className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-white transition-colors border border-gray-700"
          >
            ↺ apuestas
          </button>
          <button
            onClick={loadHistory}
            className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-white transition-colors border border-gray-700"
          >
            ↺ historial
          </button>
        </div>
      </div>

      {/* ── Dos columnas ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">

        {/* ════════════════════════════════════════════════
            COLUMNA IZQUIERDA — Ventana de apuestas
        ════════════════════════════════════════════════ */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-widest">
              Apuestas · {format(addDays(today, 1), 'dd MMM yyyy', { locale: es })}
            </p>
            {betData?.fromCache && (
              <span className="text-xs text-gray-600">desde caché</span>
            )}
          </div>

          {/* Slug */}
          <div className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2.5 mb-4">
            <p className="text-xs text-gray-600 mb-1 uppercase tracking-wider">slug del mercado</p>
            <p className="font-mono text-xs text-blue-400 break-all leading-relaxed">
              {tomorrowSlug}
            </p>
          </div>

          {/* Contenido */}
          {betLoading && (
            <div className="text-center py-8 text-gray-600 text-sm">
              <div className="inline-block w-5 h-5 border-2 border-gray-700 border-t-blue-500
                              rounded-full animate-spin mb-3" />
              <p>Consultando Polymarket…</p>
            </div>
          )}

          {betError && (
            <div className="bg-red-950/50 border border-red-900 rounded-lg p-3 text-xs text-red-400 mb-3">
              {betError}
            </div>
          )}

          {!betLoading && !betError && tokens.length === 0 && (
            <div className="text-center py-8 text-gray-600 text-sm">
              <p className="text-lg mb-2">🔍</p>
              El mercado de mañana aún no está disponible en Polymarket
            </div>
          )}

          {!betLoading && tokens.length > 0 && (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                      Temp
                    </th>
                    <th className="pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                      Prob.
                    </th>
                    <th className="text-right pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                      Precio YES
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map(t => (
                    <TokenRow
                      key={t.tempCelsius}
                      token={t}
                      isTop={topToken?.tempCelsius === t.tempCelsius}
                      maxPrice={maxPrice}
                    />
                  ))}
                </tbody>
              </table>

              {/* KPIs rápidos */}
              <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-gray-800">
                <div>
                  <p className="text-xs text-gray-600">T° impl.</p>
                  <p className="text-base font-bold text-emerald-400 mt-0.5">
                    {topToken?.tempCelsius}°C
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Precio top</p>
                  <p className="text-base font-bold text-yellow-400 mt-0.5">
                    {((topToken?.price ?? 0) * 100).toFixed(1)}¢
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Tokens</p>
                  <p className="text-base font-bold text-white mt-0.5">{tokens.length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Σ prob.</p>
                  <p className="text-base font-bold text-white mt-0.5">
                    {(totalProb * 100).toFixed(0)}¢
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ════════════════════════════════════════════════
            COLUMNA DERECHA — Simulación pasada
        ════════════════════════════════════════════════ */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-widest">
              Simulación pasada · últimos {HISTORY_DAYS} días
            </p>
            <span className="text-xs text-gray-600">
              {histResolved} / {histRows.filter(r => r.status === 'done').length} resueltos
            </span>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                  Fecha
                </th>
                <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                  Slug (fecha)
                </th>
                <th className="text-center pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                  T°MAX
                </th>
                <th className="text-right pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">
                  Estado
                </th>
              </tr>
            </thead>
            <tbody>
              {histRows.map(row => (
                <HistRow key={row.date} row={row} />
              ))}
            </tbody>
          </table>

          {/* Resumen de cobertura */}
          <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-gray-800">
            <div>
              <p className="text-xs text-gray-600">Resueltos</p>
              <p className="text-base font-bold text-emerald-400 mt-0.5">{histResolved}</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Con mercado</p>
              <p className="text-base font-bold text-white mt-0.5">{withMarket}</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Días totales</p>
              <p className="text-base font-bold text-white mt-0.5">{HISTORY_DAYS}</p>
            </div>
          </div>

          <p className="text-xs text-gray-700 mt-3">
            Datos obtenidos de la Gamma API de Polymarket vía{' '}
            <code className="bg-gray-800 px-1 rounded">/api/markets</code>.
            Los precios de resolución confirman la temperatura ganadora real.
          </p>
        </div>

      </div>
    </section>
  )
}
