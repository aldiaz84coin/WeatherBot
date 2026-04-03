// packages/dashboard/app/api/betting/retry-orders/route.ts
// Activa el flag pending_order_retry en bot_config.
// El bot lo detecta en el cron de 30s y re-ejecuta las órdenes CLOB
// del ciclo abierto para mañana usando la predicción ya guardada.

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

  // Buscar ciclo abierto para mañana
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  const { data: cycle } = await supabase
    .from('betting_cycles')
    .select('id, prediction_id, token_a_temp, token_b_temp, stake_usdc')
    .eq('target_date', tomorrowStr)
    .eq('status', 'open')
    .maybeSingle()

  if (!cycle) {
    return NextResponse.json(
      { error: `No hay ciclo abierto para ${tomorrowStr}. Usa "Relanzar ciclo" si el ciclo no se creó.` },
      { status: 404 },
    )
  }

  // Activar flag
  const { error } = await supabase
    .from('bot_config')
    .upsert({
      key:         'pending_order_retry',
      value:       true,
      description: 'Re-ejecutar órdenes Polymarket del ciclo abierto (solicitado desde dashboard)',
    })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok:          true,
    message:     'Órdenes se reenviarán en los próximos 30 segundos.',
    targetDate:  tomorrowStr,
    cycleId:     cycle.id,
    tokens:      `${cycle.token_a_temp}°C / ${cycle.token_b_temp}°C`,
    stake:       cycle.stake_usdc,
  })
}
