// packages/dashboard/app/api/bot-events/route.ts
// GET /api/bot-events?limit=80&severity=all
//
// Proxy server-side para v_bot_events_recent.
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
  const limit    = parseInt(req.nextUrl.searchParams.get('limit')    ?? '50', 10)
  const severity = req.nextUrl.searchParams.get('severity') ?? 'all'

  const supabase = getClient()

  try {
    let q = supabase
      .from('v_bot_events_recent')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(limit)

    if (severity !== 'all') {
      q = q.eq('severity', severity)
    }

    const { data, error } = await q

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ events: data ?? [] })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
