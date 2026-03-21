// app/api/backtest/run/route.ts
// Crea un job de backtest en Supabase.
// El bot (Railway) lo detecta y lo ejecuta en background.
// El dashboard puede seguir el progreso via /api/backtest/status/[id].

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Usamos service key aquí porque esta ruta es server-side y necesita escribir
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const {
      start_date,
      end_date,
      budget = 0.80,
      sources = [],
    } = body

    // Validaciones básicas
    if (!start_date || !end_date) {
      return NextResponse.json(
        { error: 'start_date y end_date son obligatorios' },
        { status: 400 }
      )
    }

    if (budget <= 0 || budget >= 1) {
      return NextResponse.json(
        { error: 'budget debe estar entre 0 y 1 USDC' },
        { status: 400 }
      )
    }

    // Verificar que no hay ya un job en ejecución
    const { data: running } = await supabase
      .from('backtest_jobs')
      .select('id')
      .in('status', ['pending', 'running'])
      .limit(1)

    if (running && running.length > 0) {
      return NextResponse.json(
        {
          error: 'Ya hay un backtest en progreso. Espera a que termine.',
          existingJobId: running[0].id,
        },
        { status: 409 }
      )
    }

    // Crear el job
    const { data: job, error } = await supabase
      .from('backtest_jobs')
      .insert({
        config: {
          start_date,
          end_date,
          budget,
          sources,
        },
        status: 'pending',
      })
      .select()
      .single()

    if (error) {
      console.error('Error creando backtest job:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      jobId: job.id,
      status: 'pending',
      message: 'Job creado. El bot lo ejecutará en los próximos 30 segundos.',
      config: job.config,
    })

  } catch (err) {
    console.error('Error en /api/backtest/run:', err)
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    )
  }
}
