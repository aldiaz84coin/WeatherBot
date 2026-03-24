// packages/bot/src/betting/logger.ts
// ──────────────────────────────────────────────────────────────────────────────
// Logger centralizado del bot. Registra TODOS los eventos en bot_events.
// El dashboard consume esta tabla para mostrar el estado operacional.
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from '../db/supabase'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type EventType =
  | 'startup'
  | 'prediction'
  | 'settlement'
  | 'stake_reset'
  | 'stake_doubled'
  | 'stake_capped'
  | 'weight_update'
  | 'error'
  | 'info'
  | 'market_pending'

export type Severity = 'info' | 'warn' | 'error' | 'success'

// ─── Logger ──────────────────────────────────────────────────────────────────

export class BotEventLogger {
  private prefix: string

  constructor(prefix = 'BOT') {
    this.prefix = prefix
  }

  /**
   * Registra un evento en bot_events Y en consola.
   */
  async log(
    severity: Severity,
    eventType: EventType,
    message: string,
    payload?: Record<string, any>,
    cycleId?: string | null,
  ): Promise<void> {
    // 1. Consola con color
    const icons: Record<Severity, string> = {
      info:    '🔵',
      warn:    '🟡',
      error:   '🔴',
      success: '✅',
    }
    console.log(`${icons[severity]} [${this.prefix}/${eventType}] ${message}`)
    if (payload) console.log('   →', JSON.stringify(payload))

    // 2. Persistir en Supabase (no lanzar excepción si falla — el bot sigue)
    try {
      const { error } = await supabase.from('bot_events').insert({
        severity,
        event_type: eventType,
        message,
        payload:    payload ?? {},
        cycle_id:   cycleId ?? null,
      })
      if (error) {
        console.error(`   ⚠️  No se pudo persistir evento: ${error.message}`)
      }
    } catch (err) {
      console.error(`   ⚠️  Error al loggear evento: ${(err as Error).message}`)
    }
  }

  // ─── Shortcuts ───────────────────────────────────────────────────────────

  async info(msg: string, payload?: Record<string, any>, cycleId?: string) {
    return this.log('info', 'info', msg, payload, cycleId)
  }

  async warn(msg: string, payload?: Record<string, any>, cycleId?: string) {
    return this.log('warn', 'info', msg, payload, cycleId)
  }

  async error(msg: string, err?: unknown, cycleId?: string) {
    const errPayload = err instanceof Error
      ? { message: err.message, stack: err.stack?.slice(0, 500) }
      : { raw: String(err) }
    return this.log('error', 'error', msg, errPayload, cycleId)
  }

  async success(msg: string, payload?: Record<string, any>, cycleId?: string) {
    return this.log('success', 'info', msg, payload, cycleId)
  }
}

// Instancia global reutilizable
export const botLogger = new BotEventLogger()
