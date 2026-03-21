// app/api/backtest/status/[id]/route.ts
// Devuelve el estado actual de un job + los últimos N logs.
// El dashboard hace polling cada pocos segundos para mostrar progreso en tiempo real.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params

  // Estado del job
  const { data: job, error: jobError } = await supabase
    .from('backtest_jobs')
    .select('*')
    .eq('id', id)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job no encontrado' }, { status: 404 })
  }

  // Últimos 100 logs del job
  const { data: logs } = await supabase
    .from('backtest_logs')
    .select('id, created_at, level, message, data')
    .eq('job_id', id)
    .order('created_at', { ascending: true })
    .limit(200)

  return NextResponse.json({
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      config: job.config,
      result: job.result,
      errorMsg: job.error_msg,
      trainingRunId: job.training_run_id,
    },
    logs: logs ?? [],
  })
}
