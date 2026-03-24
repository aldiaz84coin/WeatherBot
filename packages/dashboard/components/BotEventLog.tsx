'use client'
// packages/dashboard/components/BotEventLog.tsx
// ──────────────────────────────────────────────────────────────────────────────
// Feed en tiempo real de eventos del bot.
// Consume bot_events vía Supabase Realtime.
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Severity  = 'info' | 'warn' | 'error' | 'success'
type EventType = string

interface BotEvent {
  id:          string
  occurred_at: string
  event_type:  EventType
  severity:    Severity
  message:     string
  payload:     Record<string, unknown> | null
  cycle_date:  string | null
  cycle_stake: number | null
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
  limit?:      number
  autoScroll?: boolean
  filterSeverity?: Severity | 'all'
}

export function BotEventLog({ limit = 50, autoScroll = true, filterSeverity = 'all' }: Props) {
  const [events, setEvents]       = useState<BotEvent[]>([])
  const [loading, setLoading]     = useState(true)
  const [severity, setSeverity]   = useState<Severity | 'all'>(filterSeverity)
  const [expanded, setExpanded]   = useState<Set<string>>(new Set())
  const [connected, setConnected] = useState(false)
  const bottomRef                 = useRef<HTMLDivElement>(null)

  // ── Carga inicial ──────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      let q = supabase
        .from('v_bot_events_recent')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(limit)

      if (severity !== 'all') q = q.eq('severity', severity)

      const { data } = await q
      setEvents(data ?? [])
      setLoading(false)
    }
    load()
  }, [severity, limit])

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('bot-events-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bot_events' },
        (payload) => {
          const newEvent = payload.new as BotEvent
          // Filtrar por severity si aplica
          if (severity !== 'all' && newEvent.severity !== severity) return

          setEvents(prev => [newEvent, ...prev].slice(0, limit))

          if (autoScroll) {
            setTimeout(() => {
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }, 100)
          }
        }
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
      })

    return () => { supabase.removeChannel(channel) }
  }, [severity, limit, autoScroll])

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
          {/* Indicador de conexión Realtime */}
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            connected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'
          }`} title={connected ? 'Realtime conectado' : 'Sin conexión Realtime'} />
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
              {s === 'all' ? 'Todos'
               : s === 'success' ? '✅'
               : s === 'warn'    ? '🟡'
               : s === 'error'   ? '🔴'
               : '🔵'}
            </button>
          ))}
        </div>
      </div>

      {/* Lista de eventos */}
      <div className="divide-y divide-gray-800/50 max-h-[480px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-gray-600 text-sm">
            <div className="w-4 h-4 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
            Cargando eventos…
          </div>
        ) : events.length === 0 ? (
          <div className="py-8 text-center text-gray-600 text-sm">
            <p className="text-2xl mb-2">📭</p>
            Sin eventos registrados
          </div>
        ) : (
          events.map(ev => {
            const isExpanded = expanded.has(ev.id)
            const hasPayload = ev.payload && Object.keys(ev.payload).length > 0

            return (
              <div
                key={ev.id}
                className={`px-4 py-2.5 text-xs transition-colors ${SEVERITY_BG[ev.severity]}`}
              >
                <div className="flex items-start gap-2">
                  {/* Icono severity */}
                  <span className="mt-0.5 shrink-0 text-sm">
                    {SEVERITY_ICONS[ev.severity]}
                  </span>

                  {/* Contenido */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {/* Tipo de evento */}
                      <span className="text-gray-500 shrink-0">
                        {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                      </span>
                      {/* Fecha del ciclo */}
                      {ev.cycle_date && (
                        <span className="text-gray-600">· {ev.cycle_date}</span>
                      )}
                      {/* Stake del ciclo */}
                      {ev.cycle_stake != null && (
                        <span className="text-gray-700">· {ev.cycle_stake} USDC</span>
                      )}
                    </div>

                    {/* Mensaje */}
                    <p className={`leading-snug ${SEVERITY_TEXT[ev.severity]}`}>
                      {ev.message}
                    </p>

                    {/* Payload expandible */}
                    {hasPayload && (
                      <button
                        onClick={() => toggleExpand(ev.id)}
                        className="mt-1 text-gray-600 hover:text-gray-400 transition-colors"
                      >
                        {isExpanded ? '▲ ocultar detalles' : '▼ ver detalles'}
                      </button>
                    )}
                    {isExpanded && hasPayload && (
                      <pre className="mt-2 text-[10px] text-gray-500 bg-gray-950 rounded p-2 overflow-x-auto">
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="shrink-0 text-gray-600 text-[10px] whitespace-nowrap">
                    {format(parseISO(ev.occurred_at), 'HH:mm:ss', { locale: es })}
                    <br />
                    <span className="text-gray-700">
                      {format(parseISO(ev.occurred_at), 'dd/MM', { locale: es })}
                    </span>
                  </span>
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}
