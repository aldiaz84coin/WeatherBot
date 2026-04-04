'use client'
// packages/dashboard/components/BotEventLog.tsx
//
// CAMBIO: las queries de Supabase se hacen ahora via /api/bot-events
// (server-side) en lugar de directamente desde el browser.
// Esto evita errores CORS en redes corporativas que bloquean *.supabase.co.
// El Realtime WebSocket también se elimina (bloqueado por las mismas redes);
// se usa polling cada 30 s como única fuente de refresco.

import { useEffect, useState, useRef, useCallback } from 'react'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Severity  = 'info' | 'warn' | 'error' | 'success'
type EventType = string

interface BotEvent {
  id:           string
  occurred_at:  string
  event_type:   EventType
  severity:     Severity
  message:      string
  payload:      Record<string, unknown> | null
  cycle_date:   string | null
  cycle_stake:  number | null
  cycle_status: string | null
}

// ─── Helpers visuales ─────────────────────────────────────────────────────────

const SEVERITY_ICONS: Record<Severity, string> = {
  info:    '🔵',
  warn:    '🟡',
  error:   '🔴',
  success: '✅',
}

const SEVERITY_TEXT: Record<Severity, string> = {
  info:    'text-gray-300',
  warn:    'text-yellow-300',
  error:   'text-red-300',
  success: 'text-green-300',
}

const SEVERITY_BG: Record<Severity, string> = {
  info:    'bg-gray-800/30',
  warn:    'bg-yellow-950/30',
  error:   'bg-red-950/30',
  success: 'bg-green-950/20',
}

const EVENT_LABELS: Record<string, string> = {
  startup:        'Arranque',
  prediction:     'Predicción',
  settlement:     'Liquidación',
  stake_reset:    'Stake reseteado',
  stake_doubled:  'Stake doblado',
  stake_capped:   'Stake al tope',
  weight_update:  'Pesos actualizados',
  error:          'Error',
  info:           'Info',
  market_pending: 'Mercado pendiente',
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface Props {
  limit?:          number
  autoScroll?:     boolean
  filterSeverity?: Severity | 'all'
}

export function BotEventLog({ limit = 50, autoScroll = true, filterSeverity = 'all' }: Props) {
  const [events, setEvents]     = useState<BotEvent[]>([])
  const [loading, setLoading]   = useState(true)
  const [severity, setSeverity] = useState<Severity | 'all'>(filterSeverity)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const topRef = useRef<HTMLDivElement>(null)

  // ── Carga vía API route (server-side → sin CORS) ──────────────────────────
  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/bot-events?limit=${limit}&severity=${severity}`
      )
      if (!res.ok) return
      const { events: data } = await res.json()
      setEvents(data ?? [])
    } catch {
      // silencioso — el polling reintentará en 30 s
    } finally {
      setLoading(false)
    }
  }, [severity, limit])

  // ── Carga inicial + polling cada 30 s ─────────────────────────────────────
  useEffect(() => {
    setLoading(true)
    load()
    const interval = setInterval(load, 30_000)
    return () => clearInterval(interval)
  }, [load])

  // ── Toggle payload expandido ───────────────────────────────────────────────
  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Log del Bot
          </p>
          {/* Indicador polling */}
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"
            title="Polling cada 30 s"
          />
          <span className="text-[10px] text-gray-600">polling</span>
        </div>

        {/* Filtro de severity */}
        <div className="flex gap-1">
          {(['all', 'success', 'warn', 'error', 'info'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                severity === s
                  ? 'border-gray-500 text-white bg-gray-700'
                  : 'border-gray-800 text-gray-600 hover:text-gray-400'
              }`}
            >
              {s === 'all'     ? 'Todos'
               : s === 'success' ? '✅'
               : s === 'warn'    ? '🟡'
               : s === 'error'   ? '🔴'
               :                   '🔵'}
            </button>
          ))}
        </div>
      </div>

      {/* Lista de eventos */}
      <div className="max-h-[480px] overflow-y-auto">
        <div ref={topRef} />

        {loading && (
          <div className="flex items-center gap-2 px-4 py-3 text-gray-600 text-xs">
            <div className="w-3 h-3 border border-gray-700 border-t-blue-500 rounded-full animate-spin" />
            Cargando eventos…
          </div>
        )}

        {!loading && events.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="text-2xl">📭</span>
            <p className="text-gray-600 text-xs">Sin eventos registrados</p>
            <p className="text-gray-700 text-[10px]">
              El bot registrará eventos en bot_events cuando arranque.
            </p>
          </div>
        )}

        {events.map(ev => {
          const isExpanded = expanded.has(ev.id)
          const hasPayload = ev.payload && Object.keys(ev.payload).length > 0
          const date = (() => {
            try { return format(parseISO(ev.occurred_at), 'HH:mm:ss', { locale: es }) }
            catch { return ev.occurred_at.slice(11, 19) }
          })()

          return (
            <div
              key={ev.id}
              className={`border-b border-gray-800/50 px-4 py-2.5 ${SEVERITY_BG[ev.severity]}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-sm mt-0.5 shrink-0">{SEVERITY_ICONS[ev.severity]}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-gray-600 font-mono">{date}</span>
                    <span className="text-[10px] text-gray-600 border border-gray-800 px-1 rounded">
                      {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                    </span>
                    {ev.cycle_date && (
                      <span className="text-[10px] text-gray-600">
                        {ev.cycle_date}
                        {ev.cycle_stake != null && ` · ${ev.cycle_stake} USDC`}
                        {ev.cycle_status && ` · ${ev.cycle_status}`}
                      </span>
                    )}
                  </div>
                  <p className={`text-xs mt-0.5 leading-relaxed ${SEVERITY_TEXT[ev.severity]}`}>
                    {ev.message}
                  </p>

                  {/* Payload expandible */}
                  {hasPayload && (
                    <button
                      onClick={() => toggleExpand(ev.id)}
                      className="text-[10px] text-gray-600 hover:text-gray-400 mt-1 transition-colors"
                    >
                      {isExpanded ? '▲ ocultar datos' : '▼ ver datos'}
                    </button>
                  )}
                  {isExpanded && hasPayload && (
                    <pre className="mt-1 text-[10px] text-gray-500 bg-gray-900 rounded p-2 overflow-x-auto max-h-32">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
