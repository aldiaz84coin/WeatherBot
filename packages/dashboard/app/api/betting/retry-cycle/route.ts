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

// Calcula "mañana" en hora de Madrid para que coincida con el bot (Railway TZ = Europe/Madrid)
function getMadridTomorrow(): string {
  const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
  // en-CA produce "YYYY-MM-DD"
  const [y, m, d] = todayMadrid.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export async function POST() {
  const supabase    = getSupabase()
  const tomorrowStr = getMadridTomorrow()

  // Guard: ¿ya existe un ciclo abierto para mañana (hora Madrid)?
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
    .upsert({
      key:         'pending_betting_retry',
      value:       true,
      description: 'Retry ciclo de apuesta solicitado desde el dashboard',
    })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok:          true,
    message:     `Ciclo (+ órdenes) para ${tomorrowStr} se relanzará en ~30 segundos.`,
    targetDate:  tomorrowStr,
  })
}
