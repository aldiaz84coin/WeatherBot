// packages/dashboard/app/api/settle-manual/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Liquidación manual de un betting_cycle para una fecha pasada.
//
// Úsalo cuando el bot no obtuvo el cierre automático y el panel de Entrenamiento
// ya muestra el resolvedTemp correcto desde Polymarket.
//
// POST /api/settle-manual
//   body: { date: "2026-03-27", resolvedTemp: 18 }
//
// Lógica:
//   1. Busca el betting_cycle para esa fecha con status 'open' o 'pending'
//   2. Si actual_temp ya está relleno → devuelve info (ya liquidado)
//   3. Calcula won/lost, P&L y actualiza betting_cycles + results
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ''

// ─── GET — estado de un ciclo para una fecha ──────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date requerida (yyyy-MM-dd)' }, { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  const { data: cycle, error } = await supabase
    .from('betting_cycles')
    .select('id, status, actual_temp, token_a_temp, token_b_temp, pnl_usdc, settled_at')
    .eq('target_date', date)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ cycle })
}

// ─── POST — liquidar ciclo ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { date?: string; resolvedTemp?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  const { date, resolvedTemp } = body

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date requerida (yyyy-MM-dd)' }, { status: 400 })
  }
  if (resolvedTemp === undefined || resolvedTemp === null || isNaN(Number(resolvedTemp))) {
    return NextResponse.json({ error: 'resolvedTemp requerido (número)' }, { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // ── 1. Buscar ciclo abierto o pendiente ──────────────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .select('*')
    .eq('target_date', date)
    .in('status', ['open', 'pending'])
    .maybeSingle()

  if (cycleErr) {
    return NextResponse.json({ error: `DB error: ${cycleErr.message}` }, { status: 500 })
  }

  if (!cycle) {
    // Puede que ya esté liquidado — comprobamos
    const { data: existing } = await supabase
      .from('betting_cycles')
      .select('id, status, actual_temp, pnl_usdc')
      .eq('target_date', date)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({
        skipped: true,
        reason:  `El ciclo ya tiene status '${existing.status}'` +
                 (existing.actual_temp != null ? ` y actual_temp=${existing.actual_temp}°C` : ''),
        cycle:   existing,
      })
    }

    return NextResponse.json({
      skipped: true,
      reason:  `No hay ciclo abierto/pendiente para ${date}`,
    })
  }

  // ── 2. ¿actual_temp ya relleno? ──────────────────────────────────────────
  if (cycle.actual_temp != null) {
    return NextResponse.json({
      skipped: true,
      reason:  `actual_temp ya estaba en ${cycle.actual_temp}°C — sin acción`,
      cycle,
    })
  }

  // ── 3. Calcular resultado ────────────────────────────────────────────────
  const actualTemp   = Number(resolvedTemp)
  const roundedTemp  = Math.round(actualTemp)
  const won          = roundedTemp === cycle.token_a_temp || roundedTemp === cycle.token_b_temp
  const winningToken = won
    ? (roundedTemp === cycle.token_a_temp ? cycle.token_a_temp : cycle.token_b_temp)
    : null

  let pnl: number
  if (won && cycle.shares) {
    const gross = parseFloat((cycle.shares * 1).toFixed(4))
    pnl = parseFloat((gross - cycle.stake_usdc).toFixed(4))
  } else {
    pnl = parseFloat((-cycle.stake_usdc).toFixed(4))
  }

  // ── 4. Actualizar betting_cycle ──────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('betting_cycles')
    .update({
      status:        won ? 'won' : 'lost',
      actual_temp:   actualTemp,
      winning_token: winningToken,
      pnl_usdc:      pnl,
      settled_at:    new Date().toISOString(),
    })
    .eq('id', cycle.id)

  if (updateErr) {
    return NextResponse.json({ error: `Error actualizando cycle: ${updateErr.message}` }, { status: 500 })
  }

  // ── 5. Actualizar results (si hay prediction_id) ─────────────────────────
  if (cycle.prediction_id) {
    const winningPos = winningToken === cycle.token_a_temp ? 'a'
                     : winningToken === cycle.token_b_temp ? 'b'
                     : null

    const grossUsdc = won && cycle.shares ? parseFloat((cycle.shares * 1).toFixed(4)) : 0

    await supabase.from('results').upsert({
      prediction_id:    cycle.prediction_id,
      target_date:      date,
      actual_temp:      actualTemp,
      won,
      winning_position: winningPos,
      pnl_gross_usdc:   grossUsdc,
      cost_usdc:        cycle.stake_usdc,
      source:           'polymarket_manual',
    }, { onConflict: 'prediction_id' })

    // Marcar predicción como liquidada
    await supabase
      .from('predictions')
      .update({ settled: true, settled_at: new Date().toISOString() })
      .eq('id', cycle.prediction_id)
  }

  // ── 6. Log en bot_events ──────────────────────────────────────────────────
  // FIX: campos correctos según schema — severity / event_type / payload (no level/category/metadata)
  await supabase.from('bot_events').insert({
    severity:   won ? 'success' : 'warn',
    event_type: 'settlement',
    message:    won
      ? `✅ [MANUAL] GANADO ${date} — temp real: ${actualTemp}°C → token ${winningToken}°C. P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDC`
      : `❌ [MANUAL] PERDIDO ${date} — temp real: ${actualTemp}°C, tokens: ${cycle.token_a_temp}°C/${cycle.token_b_temp}°C. P&L: ${pnl.toFixed(4)} USDC`,
    payload:  { actualTemp, won, pnl, winningToken, source: 'dashboard_manual' },
    cycle_id: cycle.id,
  })

  return NextResponse.json({
    ok:           true,
    date,
    actualTemp,
    won,
    winningToken,
    pnl,
    tokens:       `${cycle.token_a_temp}°C / ${cycle.token_b_temp}°C`,
    message:      won
      ? `✅ Ganado — ${actualTemp}°C → token ${winningToken}°C`
      : `❌ Perdido — ${actualTemp}°C fuera de rango`,
  })
}
