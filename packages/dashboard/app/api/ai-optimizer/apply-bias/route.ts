// packages/dashboard/app/api/ai-optimizer/apply-bias/route.ts
// ──────────────────────────────────────────────────────────────────────────────
// Escribe el bias recomendado por la IA en bot_config[prediction_bias_n].
// El bot lo leerá en el próximo ciclo de apuesta (00:30) a través de
// getCurrentBias() en bias-optimizer.ts.
// ──────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Cliente inicializado dentro del handler para evitar errores en build time
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  )

  try {
    const { bias } = await req.json()

    if (typeof bias !== 'number' || isNaN(bias) || Math.abs(bias) > 5) {
      return NextResponse.json(
        { error: 'bias debe ser un número entre -5 y +5' },
        { status: 400 },
      )
    }

    const rounded = Math.round(bias * 10) / 10  // 1 decimal

    // Guardar N previo antes de sobreescribir
    const { data: current } = await supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'prediction_bias_n')
      .maybeSingle()

    const prevN = current?.value ?? 0

    await supabase
      .from('bot_config')
      .upsert(
        {
          key:         'prediction_bias_prev_n',
          value:       prevN,
          description: 'Sesgo N del ciclo anterior (backup automático)',
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'key' },
      )

    const { error } = await supabase
      .from('bot_config')
      .upsert(
        {
          key:         'prediction_bias_n',
          value:       rounded,
          description: `Sesgo N aplicado al ensemble (°C) — actualizado por IA el ${new Date().toISOString()}`,
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'key' },
      )

    if (error) throw error

    return NextResponse.json({ ok: true, bias: rounded, prevBias: prevN })

  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? 'Error interno' },
      { status: 500 },
    )
  }
}
