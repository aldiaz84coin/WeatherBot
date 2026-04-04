// packages/dashboard/app/api/ai-optimizer/apply-bias/route.ts
// ──────────────────────────────────────────────────────────────────────────────
// Escribe el bias recomendado por la IA en bot_config[prediction_bias_n].
// El bot lo leerá en el próximo ciclo de apuesta (00:30) a través de
// getCurrentBias() en bias-optimizer.ts.
//
// También registra el cambio en bot_events para que sea visible en el
// dashboard y el bot pueda confirmar que el valor persiste.
// ──────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // ── Variables de entorno compatibles con Vercel y Railway ─────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY     ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { error: 'Variables de entorno de Supabase no configuradas' },
      { status: 500 },
    )
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    const { bias } = await req.json()

    if (typeof bias !== 'number' || isNaN(bias) || Math.abs(bias) > 5) {
      return NextResponse.json(
        { error: 'bias debe ser un número entre -5 y +5' },
        { status: 400 },
      )
    }

    const rounded = Math.round(bias * 10) / 10  // 1 decimal
    const now     = new Date().toISOString()

    // ── 1. Leer N previo antes de sobreescribir ───────────────────────────────
    const { data: current } = await supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'prediction_bias_n')
      .maybeSingle()

    const prevN = typeof current?.value === 'number' ? current.value : Number(current?.value ?? 0)

    // ── 2. Backup del N previo ─────────────────────────────────────────────────
    const { error: prevErr } = await supabase
      .from('bot_config')
      .upsert(
        {
          key:         'prediction_bias_prev_n',
          value:       prevN,
          description: 'Sesgo N del ciclo anterior (backup automático)',
          updated_at:  now,
        },
        { onConflict: 'key' },
      )

    if (prevErr) {
      console.error('[apply-bias] Error guardando prevN:', prevErr)
    }

    // ── 3. Guardar nuevo N ────────────────────────────────────────────────────
    const { error } = await supabase
      .from('bot_config')
      .upsert(
        {
          key:         'prediction_bias_n',
          value:       rounded,
          description: `Sesgo N aplicado al ensemble (°C) — actualizado por IA el ${now}`,
          updated_at:  now,
        },
        { onConflict: 'key' },
      )

    if (error) throw error

    // ── 4. Registrar en bot_events para confirmación visual ───────────────────
    // FIX: campos correctos según schema: severity / event_type / payload
    const sign     = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1)
    const deltaStr = sign(rounded - prevN)

    const { error: logErr } = await supabase
      .from('bot_events')
      .insert({
        severity:   'success',
        event_type: 'weight_update',
        message:    `[AI Optimizer] Bias actualizado: ${sign(prevN)}°C → ${sign(rounded)}°C (Δ ${deltaStr}°C). Efectivo en el próximo ciclo (00:30).`,
        payload: {
          source:   'ai_optimizer',
          prevBias: prevN,
          newBias:  rounded,
          delta:    rounded - prevN,
        },
      })

    if (logErr) {
      console.error('[apply-bias] Error registrando bot_event:', logErr.message)
      // No es fatal — el bias ya está guardado
    }

    return NextResponse.json({ ok: true, bias: rounded, prevBias: prevN })

  } catch (err: any) {
    console.error('[apply-bias] Error:', err)
    return NextResponse.json(
      { error: err.message ?? 'Error interno' },
      { status: 500 },
    )
  }
}
