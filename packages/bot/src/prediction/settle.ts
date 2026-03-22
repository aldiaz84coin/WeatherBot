// src/prediction/settle.ts
// Job de liquidación diaria (corre a las 21:30 Madrid)
//
// Flujo:
//   1. Buscar predicciones de HOY no liquidadas (settled = false)
//   2. Consultar Polymarket → temperatura resuelta
//   3. Determinar qué token ganó (token_a / token_b)
//   4. Calcular pnl_gross_usdc (pnl_net_usdc es columna generada en BD)
//   5. Upsert en results + marcar prediction.settled = true
//   6. Guardar snapshot de precio de cierre

import 'dotenv/config'
import { format } from 'date-fns'
import { supabase } from '../db/supabase'
import { MarketDiscovery } from '../polymarket/market-discovery'
import { BUDGET } from './position'

export async function runDailySettlement(targetDate?: string) {
  const today  = targetDate ?? format(new Date(), 'yyyy-MM-dd')
  const isLive = process.env.LIVE_TRADING === 'true'

  console.log(`\n🔔 Settlement para: ${today}`)
  console.log(`   Modo: ${isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)

  // ── 1. Predicciones no liquidadas para hoy ────────────────────────────────
  const { data: predictions, error } = await supabase
    .from('predictions')
    .select(`
      id,
      target_date,
      ensemble_temp,
      token_a,
      token_b,
      cost_a_usdc,
      cost_b_usdc,
      simulated,
      trades (
        id,
        slug,
        token_temp,
        position,
        price_at_buy,
        shares,
        cost_usdc
      )
    `)
    .eq('target_date', today)
    .eq('settled', false)

  if (error) {
    console.error('Error consultando predicciones:', error)
    return
  }

  if (!predictions || predictions.length === 0) {
    console.log(`   ℹ️  Sin predicciones pendientes para ${today}`)
    return
  }

  console.log(`   📋 ${predictions.length} predicción(es) a liquidar`)

  // ── 2. Estado del mercado en Polymarket ───────────────────────────────────
  const discovery = new MarketDiscovery()
  const markets   = await discovery.getMarketsForDate(today)

  console.log(`   Polymarket: ${markets.available ? '✅ disponible' : '⚠️  no disponible'}`)
  console.log(`   Resuelto:   ${markets.resolvedTemp !== null ? `${markets.resolvedTemp}°C` : 'pendiente'}`)

  const actualTemp = markets.resolvedTemp

  // Si el mercado aún no resolvió, guardar snapshot parcial y salir
  if (actualTemp === null) {
    console.log(`   ⏳ Mercado ${today} aún no resuelto — se reintentará en el siguiente job`)
    return
  }

  // ── 3. Procesar cada predicción ───────────────────────────────────────────
  for (const pred of predictions) {
    const trades   = pred.trades as any[]
    const tradeA   = trades?.find(t => t.position === 'a')
    const tradeB   = trades?.find(t => t.position === 'b')

    const tokenATemp = pred.token_a as number
    const tokenBTemp = pred.token_b as number

    // ── Resultado ─────────────────────────────────────────────────────────
    const actualRounded = Math.round(actualTemp)
    const tokenAWon     = actualRounded === tokenATemp
    const tokenBWon     = actualRounded === tokenBTemp
    const won           = tokenAWon || tokenBWon

    // ── P&L ───────────────────────────────────────────────────────────────
    // pnl_net_usdc es columna GENERADA en BD: pnl_gross_usdc - cost_usdc
    // Solo insertamos pnl_gross_usdc y cost_usdc
    const sharesA    = tradeA?.shares as number | null ?? null
    const sharesB    = tradeB?.shares as number | null ?? null
    const costTotal  = (pred.cost_a_usdc ?? BUDGET.a) + (pred.cost_b_usdc ?? BUDGET.b)

    let grossUsdc = 0
    if (tokenAWon && sharesA) grossUsdc += sharesA
    if (tokenBWon && sharesB) grossUsdc += sharesB
    grossUsdc = parseFloat(grossUsdc.toFixed(4))

    // ── Snapshot de precio de cierre ──────────────────────────────────────
    if (markets.available) {
      for (const ts of [
        { slug: tradeA?.slug, temp: tokenATemp },
        { slug: tradeB?.slug, temp: tokenBTemp },
      ]) {
        if (!ts.slug) continue
        const mktToken = markets.tokens.find((t: any) => t.tempCelsius === ts.temp)
        if (mktToken) {
          await supabase.from('simulation_snapshots').insert({
            prediction_id:  pred.id,
            target_date:    today,
            slug:           ts.slug,
            token_temp:     ts.temp,
            price_snapshot: mktToken.price,
            snapshot_at:    new Date().toISOString(),
          }).catch((e: any) => console.warn('Snapshot error:', e.message))
        }
      }
    }

    // ── Upsert en results ─────────────────────────────────────────────────
    const { error: resultError } = await supabase
      .from('results')
      .upsert({
        prediction_id:   pred.id,
        target_date:     today,
        actual_temp:     actualTemp,
        resolved_token:  actualTemp,
        won,
        // pnl_net_usdc es columna generada → NO se inserta
        pnl_gross_usdc:  grossUsdc,
        cost_usdc:       costTotal,
        // Columnas extendidas modelo 2-token
        token_a_temp:    tokenATemp,
        token_b_temp:    tokenBTemp,
        token_a_won:     tokenAWon,
        token_b_won:     tokenBWon,
        price_a_at_buy:  tradeA?.price_at_buy ?? null,
        price_b_at_buy:  tradeB?.price_at_buy ?? null,
        shares_a:        sharesA,
        shares_b:        sharesB,
        source:          pred.simulated ? 'simulation' : 'live',
      }, { onConflict: 'prediction_id' })

    if (resultError) {
      console.error(`   ❌ Error guardando resultado (${pred.id}):`, resultError)
      continue
    }

    // ── Marcar predicción como liquidada ──────────────────────────────────
    await supabase
      .from('predictions')
      .update({ settled: true, settled_at: new Date().toISOString() })
      .eq('id', pred.id)

    // ── Log ───────────────────────────────────────────────────────────────
    const pnlNet   = parseFloat((grossUsdc - costTotal).toFixed(4))
    const status   = won
      ? `✅ GANADA  gross=${grossUsdc} | neto=${pnlNet > 0 ? '+' : ''}${pnlNet} USDC`
      : `❌ PERDIDA neto=${pnlNet} USDC`

    console.log(`\n   📊 ${today}`)
    console.log(`      Ensemble:  ${pred.ensemble_temp?.toFixed(2)}°C`)
    console.log(`      Token A:   ${tokenATemp}°C ${tokenAWon ? '✓' : '✗'}`)
    console.log(`      Token B:   ${tokenBTemp}°C ${tokenBWon ? '✓' : '✗'}`)
    console.log(`      Real:      ${actualTemp}°C`)
    console.log(`      ${status}`)
  }

  console.log(`\n✅ Settlement completado para ${today}`)
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────
// Uso: pnpm settle            → liquida hoy
//      pnpm settle 2026-03-21 → liquida una fecha concreta
if (require.main === module) {
  const dateArg = process.argv[2]
  runDailySettlement(dateArg).catch(console.error)
}
