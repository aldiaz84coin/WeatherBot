// packages/dashboard/app/api/betting/status/route.ts
// GET /api/betting/status?tomorrow=YYYY-MM-DD
//
// Proxy server-side para los datos del motor de apuestas.
// El browser llama a esta ruta (mismo origen → sin CORS).
// Esta ruta llama a Supabase desde Vercel (sin restricciones de red).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getClient() {
  const url = process.env.SUPABASE_URL         ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

export async function GET(req: NextRequest) {
  const tomorrow = req.nextUrl.searchParams.get('tomorrow') ?? ''

  const supabase = getClient()

  try {
    const [
      { data: status,  error: e1 },
      { data: cycles,  error: e2 },
      { data: tmw,     error: e3 },
    ] = await Promise.all([
      supabase
        .from('v_betting_status')
        .select('*')
        .maybeSingle(),

      supabase
        .from('betting_cycles')
        .select('id,target_date,stake_usdc,multiplier,token_a_temp,token_b_temp,actual_temp,status,pnl_usdc,simulated,capped_at_max')
        .order('target_date', { ascending: false })
        .limit(20),

      tomorrow
        ? supabase
            .from('betting_cycles')
            .select(`
              id, target_date, stake_usdc, multiplier,
              token_a_temp, token_b_temp, status, simulated, prediction_id,
              predictions (
                ensemble_temp, ensemble_adjusted, bias_applied,
                cost_a_usdc, cost_b_usdc,
                token_a, token_b
              )
            `)
            .eq('target_date', tomorrow)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
    // e3: si no existe ciclo de mañana es null, no es error

    return NextResponse.json({
      status:        status ?? null,
      cycles:        cycles ?? [],
      tomorrowCycle: tmw    ?? null,
    })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
