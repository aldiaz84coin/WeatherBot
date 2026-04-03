// packages/dashboard/app/api/betting/retry-cycle/route.ts
// Activa el flag pending_betting_retry en bot_config.
// El scheduler del bot (cada 30 s) lo detecta y llama runBettingCycle().

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL  ?? process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY      ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

export async function POST() {
  const supabase = getSupabase()

  // Guard: ¿ya existe un ciclo abierto para mañana?
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  const { data: existing } = await supabase
    .from('betting_cycles')
    .select('id, status')
    .eq('target_date', tomorrowStr)
    .maybeSingle()

  if (existing && existing.status === 'open') {
    return NextResponse.json(
      { error: `Ya existe un ciclo abierto para ${tomorrowStr} (id: ${existing.id})` },
      { status: 409 },
    )
  }

  // Activar flag
  const { error } = await supabase
    .from('bot_config')
    .upsert({ key: 'pending_betting_retry', value: true, description: 'Retry ciclo de apuesta solicitado desde el dashboard' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    message: 'Flag activado. El bot relanzará el ciclo en los próximos 30 segundos.',
    targetDate: tomorrowStr,
  })
}
