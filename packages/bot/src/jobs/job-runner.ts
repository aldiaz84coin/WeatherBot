// src/jobs/job-runner.ts
// Polling de jobs de backtest pendientes en Supabase.
// El bot comprueba cada 30 segundos si hay jobs pendientes y los ejecuta.
// Esto permite que el dashboard dispare backtests sin necesidad de
// un endpoint HTTP expuesto en el bot.

import 'dotenv/config'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { runRealBacktest } from '../training/real-backtest'
import { format, subDays, parseISO } from 'date-fns'

let isRunning = false  // Evitar ejecuciones concurrentes

export async function checkAndRunPendingJobs(): Promise<void> {
  if (isRunning) return

  try {
    // Buscar job pendiente más antiguo
    const { data: job } = await supabase
      .from('backtest_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (!job) return

    isRunning = true
    console.log(`[JobRunner] Ejecutando job ${job.id}...`)

    const cfg = job.config as {
      start_date?: string
      end_date?: string
      budget?: number
      sources?: string[]
    }

    // Cargar configuración desde Supabase si no viene en el job
    const { data: botConfig } = await supabase
      .from('bot_config')
      .select('key, value')
      .in('key', ['daily_budget_usdc', 'active_sources'])

    const configMap = Object.fromEntries(
      (botConfig ?? []).map(r => [r.key, r.value])
    )

    const budget = cfg.budget ?? parseFloat(configMap['daily_budget_usdc'] ?? '0.80')
    const sources: string[] = cfg.sources ?? (configMap['active_sources'] as string[] ?? [])

    const endDate = cfg.end_date ?? format(subDays(new Date(), 1), 'yyyy-MM-dd')
    const startDate = cfg.start_date ?? format(subDays(new Date(), 90), 'yyyy-MM-dd')

    // Configurar manager con las fuentes activas
    const manager = await setupManager()

    try {
      await runRealBacktest(manager, {
        startDate,
        endDate,
        budget,
        activeSources: sources.length > 0 ? sources : manager.getRegisteredSources(),
        jobId: job.id,
      })
    } catch (err) {
      console.error('[JobRunner] Error ejecutando backtest:', err)
      await supabase.from('backtest_jobs').update({
        status: 'error',
        finished_at: new Date().toISOString(),
        error_msg: (err as Error).message,
      }).eq('id', job.id)

      await supabase.from('backtest_logs').insert({
        job_id: job.id,
        level: 'error',
        message: `Error fatal: ${(err as Error).message}`,
      })
    }

  } catch (err) {
    // No hay jobs pendientes (single() lanza error si no hay filas)
    // Silenciar este error específico
    const msg = (err as any)?.message ?? ''
    if (!msg.includes('No rows found') && !msg.includes('JSON object requested')) {
      console.error('[JobRunner] Error al buscar jobs:', err)
    }
  } finally {
    isRunning = false
  }
}

// Iniciar polling (se llama desde scheduler.ts)
export function startJobRunner(intervalMs = 30_000): void {
  console.log(`[JobRunner] Iniciado — comprobando jobs cada ${intervalMs / 1000}s`)
  checkAndRunPendingJobs() // Comprobar inmediatamente al arrancar
  setInterval(checkAndRunPendingJobs, intervalMs)
}
