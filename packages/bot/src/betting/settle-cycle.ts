// packages/bot/src/betting/settle-cycle.ts
// ──────────────────────────────────────────────────────────────────────────────
// Job de liquidación del ciclo de apuesta — se ejecuta a las 21:30 Madrid.
//
// Flujo:
//   1. Buscar betting_cycle abierto para HOY
//   2. Consultar temperatura real en Polymarket
//   3. Determinar si ganamos (token_a_temp o token_b_temp == round(actualTemp))
//   4. Calcular P&L
//   5. Actualizar betting_cycle + tabla results
//   6. Loggear resultado en bot_events
//   7. Aplicar Martingala:
//      - Win  → reset stake al base (multiplicador = 1)
//      - Loss → doblar stake (min(base * mult * 2, max))
//
// NOTA: La optimización de pesos ya NO se ejecuta aquí.
//       Los pesos se gestionan exclusivamente desde el AI Optimizer del dashboard.
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import { format } from 'date-fns'
import { supabase } from '../db/supabase'
import { MarketDiscovery } from '../polymarket/market-discovery'
import { BotEventLogger } from './logger'
import { getStakeConfig, resetStake, doubleStake } from './config'

const logger = new BotEventLogger('SETTLE')

// ─── Runner principal ─────────────────────────────────────────────────────────

export async function settleBettingCycle(targetDate?: string): Promise<void> {
  const today = targetDate ?? format(new Date(), 'yyyy-MM-dd')

  await logger.log('info', 'settlement', `──── Settlement ${today} ────`)

  // ── 1. Buscar ciclo abierto ───────────────────────────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .select('*')
    .eq('target_date', today)
    .eq('status', 'open')
    .maybeSingle()

  if (cycleErr) {
    await logger.error(`Error consultando betting_cycles: ${cycleErr.message}`)
    return
  }

  if (!cycle) {
    await logger.log('warn', 'info', `No hay ciclo abierto para ${today} — sin acción`)
    return
  }

  // ── 2. Temperatura real de Polymarket ─────────────────────────────────────
  let actualTemp: number | null = null

  try {
    const discovery = new MarketDiscovery()
    const markets   = await discovery.getMarketsForDate(today)

    if (markets.resolvedTemp === null) {
      await logger.log('warn', 'market_pending',
        `Mercado ${today} aún no resuelto — se reintentará en el cron de las 23:00`,
        { cycleId: cycle.id },
        cycle.id
      )
      return
    }
    actualTemp = markets.resolvedTemp
  } catch (err) {
    await logger.error(`Error consultando Polymarket: ${(err as Error).message}`, err, cycle.id)
    return
  }

  // ── 3. ¿Ganamos? ──────────────────────────────────────────────────────────
  const roundedTemp  = Math.round(actualTemp)
  const won          = roundedTemp === cycle.token_a_temp || roundedTemp === cycle.token_b_temp
  const winningToken = won
    ? (roundedTemp === cycle.token_a_temp ? cycle.token_a_temp : cycle.token_b_temp)
    : null

  // ── 4. P&L ────────────────────────────────────────────────────────────────
  // Si ganamos: el token resuelto a 1 USDC/share → gross = shares, neto = shares - stake
  // Si perdemos: neto = -stake
  // Fallback: si cycle.shares es null (ciclos antiguos), recalcular desde stake/(priceA+priceB)
  let sharesEff: number | null = cycle.shares ?? null
  if (sharesEff == null && cycle.price_a != null && cycle.price_b != null) {
    const priceSum = cycle.price_a + cycle.price_b
    if (priceSum > 0) sharesEff = cycle.stake_usdc / priceSum
  }

  let pnl: number
  if (won && sharesEff) {
    const gross = parseFloat((sharesEff * 1).toFixed(4))
    pnl = parseFloat((gross - cycle.stake_usdc).toFixed(4))
  } else {
    pnl = parseFloat((-cycle.stake_usdc).toFixed(4))
  }

  // ── 5. Actualizar betting_cycle ───────────────────────────────────────────
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
    await logger.error(`Error actualizando cycle: ${updateErr.message}`, updateErr, cycle.id)
  }

  // ── 6. Actualizar results (tabla existente) ───────────────────────────────
  if (cycle.prediction_id) {
    const winningPos = winningToken === cycle.token_a_temp ? 'a'
                     : winningToken === cycle.token_b_temp ? 'b'
                     : null

    const { error: resultsErr } = await supabase.from('results').upsert({
      prediction_id:    cycle.prediction_id,
      target_date:      today,
      actual_temp:      actualTemp,
      won,
      winning_position: winningPos,
      pnl_gross_usdc:   won && sharesEff ? sharesEff : 0,
      cost_usdc:        cycle.stake_usdc,
      source:           'polymarket',
    }, { onConflict: 'prediction_id' })

    if (resultsErr) {
      await logger.error(`Error upsert results: ${resultsErr.message}`, resultsErr, cycle.id)
    }

    // Marcar predicción como liquidada
    await supabase
      .from('predictions')
      .update({ settled: true, settled_at: new Date().toISOString() })
      .eq('id', cycle.prediction_id)
  }

  // ── 7. Loggear resultado ──────────────────────────────────────────────────
  await logger.log(
    won ? 'success' : 'warn',
    'settlement',
    won
      ? `✅ GANADO ${today} — temp real: ${actualTemp}°C → token ${winningToken}°C resolvió YES. P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USDC`
      : `❌ PERDIDO ${today} — temp real: ${actualTemp}°C, tokens: ${cycle.token_a_temp}°C/${cycle.token_b_temp}°C. P&L: ${pnl.toFixed(4)} USDC`,
    { actualTemp, won, pnl, winningToken, tokens: `${cycle.token_a_temp}/${cycle.token_b_temp}` },
    cycle.id
  )

  // ── 8. Martingala ─────────────────────────────────────────────────────────
  const currentStake = await getStakeConfig()

  if (won) {
    await resetStake()
    await logger.log('success', 'stake_reset',
      `Stake reseteado → ${currentStake.baseStake} USDC (mult × 1)`,
      { newStake: currentStake.baseStake, multiplier: 1 },
      cycle.id
    )
  } else {
    const next = await doubleStake(currentStake)

    if (next.cappedAtMax) {
      await logger.log('warn', 'stake_capped',
        `⚠️ Stake doblado pero TOPE alcanzado — próxima apuesta: ${next.currentStake} USDC (max: ${next.maxStake} USDC)`,
        { ...next },
        cycle.id
      )
    } else {
      await logger.log('warn', 'stake_doubled',
        `Stake doblado: ${currentStake.baseStake} × ${next.multiplier} = ${next.currentStake} USDC`,
        { ...next },
        cycle.id
      )
    }
  }
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────

if (require.main === module) {
  settleBettingCycle().catch(err => {
    console.error('Fatal en settleBettingCycle:', err)
    process.exit(1)
  })
}
