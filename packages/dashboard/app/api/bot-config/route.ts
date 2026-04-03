// packages/dashboard/app/api/bot-config/route.ts
// PATCH /api/bot-config — permite al dashboard actualizar valores de bot_config en Supabase
// Usa service key (variable de servidor, no pública) para bypass de RLS.
//
// NOTA: Al cambiar betting_mode a "live", automáticamente setea pending_live_switch=true
// para que el bot ejecute la compra pendiente en modo real en el siguiente ciclo de 30 s.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const ALLOWED_KEYS = ['betting_mode', 'base_stake_usdc', 'max_stake_usdc']

function getServiceClient() {
  const url = process.env.SUPABASE_URL         ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key)
}

export async function PATCH(req: NextRequest) {
  let body: { key?: string; value?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { key, value } = body

  if (!key || value === undefined) {
    return NextResponse.json({ error: 'Se requieren key y value' }, { status: 400 })
  }

  if (!ALLOWED_KEYS.includes(key)) {
    return NextResponse.json({ error: `Key '${key}' no permitida` }, { status: 403 })
  }

  // ── Validaciones de dominio ───────────────────────────────────────────────
  if (key === 'betting_mode' && value !== 'simulated' && value !== 'live') {
    return NextResponse.json({ error: 'betting_mode debe ser "simulated" o "live"' }, { status: 400 })
  }
  if ((key === 'base_stake_usdc' || key === 'max_stake_usdc') && (typeof value !== 'number' || value <= 0)) {
    return NextResponse.json({ error: 'El stake debe ser un número positivo' }, { status: 400 })
  }
  if (key === 'base_stake_usdc' && typeof value === 'number' && value < 1) {
    return NextResponse.json({ error: 'base_stake mínimo: 1 USDC' }, { status: 400 })
  }

  const supabase = getServiceClient()

  // ── Actualizar el valor solicitado ────────────────────────────────────────
  const { error } = await supabase
    .from('bot_config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Al activar modo LIVE: setear flag para que el bot ejecute compra pendiente ──
  if (key === 'betting_mode' && value === 'live') {
    const { error: flagErr } = await supabase
      .from('bot_config')
      .update({ value: true, updated_at: new Date().toISOString() })
      .eq('key', 'pending_live_switch')

    if (flagErr) {
      // No es fatal — loguear pero seguir
      console.error('[bot-config] Error seteando pending_live_switch:', flagErr.message)
    } else {
      console.log('[bot-config] ✅ pending_live_switch=true — el bot ejecutará la compra pendiente en los próximos 30 s')
    }
  }

  // ── Al volver a simulado: limpiar flag por si quedó pendiente ─────────────
  if (key === 'betting_mode' && value === 'simulated') {
    await supabase
      .from('bot_config')
      .update({ value: false, updated_at: new Date().toISOString() })
      .eq('key', 'pending_live_switch')
  }

  return NextResponse.json({ ok: true, key, value })
}

export async function GET() {
  const supabase = getServiceClient()

  const { data, error } = await supabase
    .from('bot_config')
    .select('key, value, description, updated_at')
    .in('key', ALLOWED_KEYS)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
