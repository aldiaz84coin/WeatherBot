'use client'
// components/PolymarketSimPanel.tsx
// Panel de simulación Polymarket — ventana de apuestas de mañana + historial de días pasados.
// NUEVO: botones de liquidación manual para ciclos que el bot no liquidó automáticamente.

import { useState, useEffect, useCallback } from 'react'
import { format, addDays, subDays } from 'date-fns'
import { es } from 'date-fns/locale'
import { createClient } from '@supabase/supabase-js'

// ─── Supabase (solo lectura desde el dashboard) ───────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TemperatureToken {
  tempCelsius: number
  price:       number
  resolved:    boolean
  resolvedYes: boolean
}

interface DayMarkets {
  date:          string
  available:     boolean
  tokens:        TemperatureToken[]
  resolvedTemp:  number | null
  totalPriceSum: number
  fetchedAt:     string
  fromCache?:    boolean
}

interface HistoryRow {
  date:   string
  slug:   string
  data:   DayMarkets | null
  status: 'loading' | 'done' | 'error'
}

// Estado de cada ciclo en BD: null = no hay ciclo, 'open'/'pending' = pendiente, 'won'/'lost' = ya liquidado
interface CycleStatus {
  id:          string
  status:      string
  actual_temp: number | null
  token_a:     number | null
  token_b:     number | null
  pnl:         number | null
}

type SyncState = 'idle' | 'loading' | 'ok' | 'skipped' | 'error'

interface SyncResult {
  state:   SyncState
  message: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDaySlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `highest-temperature-in-madrid-on-${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}

function fmtShort(date: string) {
  return format(new Date(date + 'T12:00:00'), 'dd MMM', { locale: es })
}

function priceColor(p: number) {
  if (p >= 0.6) return 'text-emerald-400'
  if (p >= 0.3) return 'text-yellow-400'
  return 'text-gray-500'
}

// ─── Sub-componente: fila de token ────────────────────────────────────────────

function TokenRow({
  token,
  isTop,
  maxPrice,
}: {
  token:    TemperatureToken
  isTop:    boolean
  maxPrice: number
}) {
  const barPct   = maxPrice > 0 ? ((token.price / maxPrice) * 100).toFixed(1) : '0'
  const barColor =
     token.tempCelsius >= 30 ? 'bg-gradient-to-r from-amber-500 to-red-500'
   : token.tempCelsius >= 22 ? 'bg-gradient-to-r from-emerald-500 to-blue-500'
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

// ─── Sub-componente: fila de historial ────────────────────────────────────────

function HistRow({
  row,
  cycle,
  onSettle,
  syncResult,
}: {
  row:        HistoryRow
  cycle:      CycleStatus | null | undefined
  onSettle:   (date: string, resolvedTemp: number) => void
  syncResult: SyncResult | null
}) {
  const shortSlug = row.slug.replace('highest-temperature-in-madrid-on-', '')
  const { data, status } = row

  // ¿Puede liquidarse? — hay resolvedTemp de Polymarket Y hay ciclo abierto/pendiente
  const canSettle =
    data?.resolvedTemp != null &&
    cycle != null &&
    (cycle.status === 'open' || cycle.status === 'pending') &&
    cycle.actual_temp == null

  // Estado del ciclo en BD para mostrar
  const cycleTag = () => {
    if (cycle === undefined) return null // aún cargando
    if (cycle === null) return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-600 border border-gray-700">
        sin ciclo
      </span>
    )
    if (cycle.status === 'won') return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900">
        ✅ won {cycle.actual_temp}°C
      </span>
    )
    if (cycle.status === 'lost') return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-red-950 text-red-400 border border-red-900">
        ❌ lost {cycle.actual_temp}°C
      </span>
    )
    if (cycle.status === 'open' || cycle.status === 'pending') return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-yellow-950 text-yellow-400 border border-yellow-900">
        ⏳ {cycle.status}
      </span>
    )
    return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700">
        {cycle.status}
      </span>
    )
  }

  if (status === 'loading') {
    return (
      <tr className="border-b border-gray-800/50 animate-pulse">
        <td className="py-2 pr-3 font-mono text-xs text-gray-500">{fmtShort(row.date)}</td>
        <td className="py-2 pr-3 font-mono text-xs text-gray-700">{shortSlug}</td>
        <td className="py-2 pr-3 text-center"><span className="text-gray-700 font-mono text-xs">—</span></td>
        <td className="py-2 pr-2 text-center"><span className="text-gray-700 text-xs">…</span></td>
        <td className="py-2 text-right"><span className="inline-block text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-600">…</span></td>
      </tr>
    )
  }

  if (status === 'error' || !data) {
    return (
      <tr className="border-b border-gray-800/50">
        <td className="py-2 pr-3 font-mono text-xs text-gray-500">{fmtShort(row.date)}</td>
        <td className="py-2 pr-3 font-mono text-xs text-gray-700">{shortSlug}</td>
        <td className="py-2 pr-3 text-center"><span className="text-gray-600 text-xs">—</span></td>
        <td className="py-2 pr-2 text-center">{cycleTag()}</td>
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

  const isSyncing = syncResult?.state === 'loading'

  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
      <td className="py-2 pr-3 font-mono text-xs text-gray-400">{fmtShort(row.date)}</td>
      <td className="py-2 pr-3 font-mono text-xs text-gray-600 max-w-0 truncate" title={row.slug}>
        {shortSlug}
      </td>

      {/* T°MAX de Polymarket */}
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

      {/* Estado ciclo en BD + botón liquidar */}
      <td className="py-2 pr-2 text-center">
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          {cycleTag()}
          {canSettle && (
            syncResult?.state === 'ok' ? (
              <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900">
                ✓ sync
              </span>
            ) : syncResult?.state === 'error' ? (
              <span className="inline-block text-xs px-1.5 py-0.5 rounded bg-red-950 text-red-400 border border-red-900"
                    title={syncResult.message ?? ''}>
                ⚠ error
              </span>
            ) : (
              <button
                onClick={() => onSettle(row.date, data.resolvedTemp!)}
                disabled={isSyncing}
                className="inline-block text-xs px-1.5 py-0.5 rounded
                           bg-blue-950 text-blue-300 border border-blue-800
                           hover:bg-blue-900 hover:text-blue-100
                           disabled:opacity-40 disabled:cursor-wait
                           transition-colors"
                title={`Liquidar ${row.date} con ${data.resolvedTemp}°C`}
              >
                {isSyncing ? '⏳' : '↯ liquidar'}
              </button>
            )
          )}
        </div>
      </td>

      {/* Badge estado Polymarket */}
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

// ─── Componente principal ──────────────────────────────────────────────────────

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

  // ── Estado ciclos en BD (por fecha) ──
  // undefined = aún cargando | null = no existe ciclo | CycleStatus = encontrado
  const [cycleMap, setCycleMap] = useState<Record<string, CycleStatus | null | undefined>>({})

  // ── Estado sync por fecha ──
  const [syncMap, setSyncMap] = useState<Record<string, SyncResult>>({})

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

  // ── Fetch historial de Polymarket (concurrente) ──
  const loadHistory = useCallback(async () => {
    const dates = Array.from({ length: HISTORY_DAYS }, (_, i) =>
      format(subDays(today, i + 1), 'yyyy-MM-dd')
    )

    setHistRows(dates.map(d => ({
      date: d, slug: buildDaySlug(d), data: null, status: 'loading' as const,
    })))
    setHistResolved(0)
    setSyncMap({})
    // Reset cycleMap a "cargando"
    setCycleMap(Object.fromEntries(dates.map(d => [d, undefined])))

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
          if (data?.resolvedTemp != null) {
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

  // ── Fetch ciclos de Supabase para las fechas del historial ──
  const loadCycles = useCallback(async () => {
    const dates = Array.from({ length: HISTORY_DAYS }, (_, i) =>
      format(subDays(today, i + 1), 'yyyy-MM-dd')
    )

    const { data, error } = await supabase
      .from('betting_cycles')
      .select('id, status, actual_temp, token_a_temp, token_b_temp, pnl_usdc, target_date')
      .in('target_date', dates)

    if (error) {
      console.warn('[PolymarketSimPanel] Error cargando ciclos:', error.message)
      return
    }

    const map: Record<string, CycleStatus | null> = Object.fromEntries(dates.map(d => [d, null]))
    for (const row of data ?? []) {
      map[row.target_date] = {
        id:          row.id,
        status:      row.status,
        actual_temp: row.actual_temp,
        token_a:     row.token_a_temp,
        token_b:     row.token_b_temp,
        pnl:         row.pnl_usdc,
      }
    }
    setCycleMap(map)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadTomorrow()
    loadHistory()
    loadCycles()
  }, [loadTomorrow, loadHistory, loadCycles])

  // ── Liquidar un ciclo manualmente ─────────────────────────────────────────
  const handleSettle = useCallback(async (date: string, resolvedTemp: number) => {
    setSyncMap(prev => ({ ...prev, [date]: { state: 'loading', message: null } }))
    try {
      const res = await fetch('/api/settle-manual', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date, resolvedTemp }),
      })
      const json = await res.json()

      if (!res.ok) {
        setSyncMap(prev => ({ ...prev, [date]: { state: 'error', message: json.error ?? `HTTP ${res.status}` } }))
        return
      }

      if (json.skipped) {
        setSyncMap(prev => ({ ...prev, [date]: { state: 'skipped', message: json.reason } }))
        return
      }

      // Actualizar el cycleMap local para reflejar el nuevo estado sin recargar
      setCycleMap(prev => ({
        ...prev,
        [date]: {
          ...prev[date]!,
          status:      json.won ? 'won' : 'lost',
          actual_temp: json.actualTemp,
          pnl:         json.pnl,
        } as CycleStatus,
      }))
      setSyncMap(prev => ({ ...prev, [date]: { state: 'ok', message: json.message } }))
    } catch (e) {
      setSyncMap(prev => ({ ...prev, [date]: { state: 'error', message: (e as Error).message } }))
    }
  }, [])

  // ── "Sync all" — liquida todos los que puedan ────────────────────────────
  const handleSyncAll = useCallback(async () => {
    const toSettle = histRows.filter(row => {
      const cycle = cycleMap[row.date]
      return (
        row.data?.resolvedTemp != null &&
        cycle != null &&
        (cycle.status === 'open' || cycle.status === 'pending') &&
        cycle.actual_temp == null
      )
    })
    for (const row of toSettle) {
      await handleSettle(row.date, row.data!.resolvedTemp!)
    }
  }, [histRows, cycleMap, handleSettle])

  // ── Derived ───────────────────────────────────────────────────────────────
  const tokens    = betData?.tokens ?? []
  const topToken  = tokens.length > 0
    ? tokens.reduce((a, b) => (b.price > a.price ? b : a), tokens[0])
    : null
  const maxPrice  = tokens.length > 0 ? Math.max(...tokens.map(t => t.price)) : 1
  const totalProb = tokens.reduce((s, t) => s + t.price, 0)
  const withMarket = histRows.filter(r => r.data?.available).length

  const pendingSync = histRows.filter(row => {
    const cycle = cycleMap[row.date]
    return (
      row.data?.resolvedTemp != null &&
      cycle != null &&
      (cycle.status === 'open' || cycle.status === 'pending') &&
      cycle.actual_temp == null
    )
  }).length

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
        <div className="flex gap-2 flex-wrap justify-end">
          {pendingSync > 0 && (
            <button
              onClick={handleSyncAll}
              className="text-xs px-2.5 py-1 rounded bg-blue-950 text-blue-300
                         hover:bg-blue-900 hover:text-blue-100 transition-colors border border-blue-800 font-medium"
            >
              ↯ sync all ({pendingSync})
            </button>
          )}
          <button
            onClick={loadTomorrow}
            className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-white transition-colors border border-gray-700"
          >
            ↺ apuestas
          </button>
          <button
            onClick={() => { loadHistory(); loadCycles() }}
            className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400
                       hover:bg-gray-700 hover:text-white transition-colors border border-gray-700"
          >
            ↺ historial
          </button>
        </div>
      </div>

      {/* ── Dos columnas ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">

        {/* ════ COLUMNA IZQUIERDA — Ventana de apuestas ════ */}
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
                    <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Temp</th>
                    <th className="pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Prob.</th>
                    <th className="text-right pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Precio YES</th>
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

              <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-gray-800">
                <div>
                  <p className="text-xs text-gray-600">T° impl.</p>
                  <p className="text-base font-bold text-emerald-400 mt-0.5">{topToken?.tempCelsius}°C</p>
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

        {/* ════ COLUMNA DERECHA — Simulación pasada ════ */}
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
                <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Fecha</th>
                <th className="text-left pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider hidden sm:table-cell">Slug</th>
                <th className="text-center pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">T°MAX</th>
                <th className="text-center pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Ciclo BD</th>
                <th className="text-right pb-2 text-xs text-gray-600 font-normal uppercase tracking-wider">Estado</th>
              </tr>
            </thead>
            <tbody>
              {histRows.map(row => (
                <HistRow
                  key={row.date}
                  row={row}
                  cycle={cycleMap[row.date]}
                  onSettle={handleSettle}
                  syncResult={syncMap[row.date] ?? null}
                />
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

          {pendingSync > 0 && (
            <div className="mt-3 p-2.5 rounded-lg bg-blue-950/40 border border-blue-900/50">
              <p className="text-xs text-blue-300">
                ↯ {pendingSync} ciclo{pendingSync > 1 ? 's' : ''} sin liquidar con temperatura conocida.
                Usa <strong>↯ sync all</strong> o el botón individual por fila.
              </p>
            </div>
          )}

          <p className="text-xs text-gray-700 mt-3">
            T°MAX de Polymarket via <code className="bg-gray-800 px-1 rounded">/api/markets</code>.
            Ciclo BD = estado en <code className="bg-gray-800 px-1 rounded">betting_cycles</code>.
            «↯ liquidar» rellena <code className="bg-gray-800 px-1 rounded">actual_temp</code> si el bot no lo hizo.
          </p>
        </div>

      </div>
    </section>
  )
}
