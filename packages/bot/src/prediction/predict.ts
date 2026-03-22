// src/prediction/predict.ts
// Job diario de predicción (corre a las 18:00 Madrid)
//
// Flujo:
//   1. Cargar pesos óptimos del último training_run exitoso
//   2. Calcular ensemble_temp para mañana
//   3. Determinar token_a = ceil(pred) y token_b = ceil(pred)+1
//   4. Obtener precios actuales de Polymarket (simulados o reales)
//   5. Guardar prediction + 2 trades en Supabase
//   6. Si LIVE_TRADING=true → ejecutar órdenes en el CLOB

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { buildPosition } from './position'
import { ClobClient } from '../polymarket/clob'

// ─── Runner principal ─────────────────────────────────────────────────────────

export async function runDailyPrediction() {
  const tomorrow  = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const isLive    = process.env.LIVE_TRADING === 'true'

  console.log(`\n🌡️  Predicción para: ${tomorrow}`)
  console.log(`   Modo: ${isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)

  // ── Evitar duplicados ────────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('predictions')
    .select('id')
    .eq('target_date', tomorrow)
    .maybeSingle()

  if (existing) {
    console.log(`   ⏩ Ya existe predicción para ${tomorrow} (id: ${existing.id}), saltando.`)
    return existing
  }

  // ── 1. Pesos del último training_run exitoso ──────────────────────────────────
  const { data: latestRun } = await supabase
    .from('training_runs')
    .select('best_ensemble')
    .eq('passed', true)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const weights  = latestRun?.best_ensemble ?? undefined
  const manager  = await setupManager(weights)

  // ── 2. Ensemble forecast ──────────────────────────────────────────────────────
  const ensemble = await manager.getEnsembleForecast(tomorrow)

  console.log(`   Ensemble:    ${ensemble.ensembleTemp.toFixed(2)}°C`)
  console.log(`   Fuentes:     ${JSON.stringify(ensemble.sourceTemps)}`)
  console.log(`   Pesos:       ${JSON.stringify(ensemble.weights)}`)

  // ── 3. Construir posición 2 tokens ────────────────────────────────────────────
  const position = await buildPosition(ensemble.ensembleTemp, tomorrow)

  console.log(`   ceil(pred):  ${position.tokenA.tempCelsius}°C  →  ${position.tokenA.slug}`)
  console.log(`   ceil+1:      ${position.tokenB.tempCelsius}°C  →  ${position.tokenB.slug}`)
  console.log(`   Mercado:     ${position.marketAvailable ? '✅ disponible' : '⚠️  no disponible aún'}`)
  console.log(`   Coste total: ${position.totalCostUsdc} USDC`)

  // ── 4. Guardar prediction ─────────────────────────────────────────────────────
  const { data: prediction, error: predError } = await supabase
    .from('predictions')
    .insert({
      target_date:     tomorrow,
      ensemble_temp:   ensemble.ensembleTemp,
      source_temps:    ensemble.sourceTemps,
      ensemble_config: ensemble.weights,
      // 2-token model
      token_a:         position.tokenA.tempCelsius,
      token_b:         position.tokenB.tempCelsius,
      cost_a_usdc:     position.tokenA.costUsdc,
      cost_b_usdc:     position.tokenB.costUsdc,
      // legacy columns (null en modelo nuevo)
      token_low:       null,
      token_mid:       null,
      token_high:      null,
      cost_low_usdc:   null,
      cost_mid_usdc:   null,
      cost_high_usdc:  null,
      simulated:       !isLive,
      settled:         false,
    })
    .select()
    .single()

  if (predError || !prediction) {
    console.error('❌ Error guardando predicción:', predError)
    throw predError
  }

  console.log(`   ✅ Prediction guardada (id: ${prediction.id})`)

  // ── 5. Guardar trades + ejecutar si LIVE ──────────────────────────────────────
  const clob = isLive ? new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  ) : null

  for (const token of [position.tokenA, position.tokenB]) {
    let polymarketOrderId: string | null = null

    if (isLive && clob && token.priceAtBuy && position.marketAvailable) {
      try {
        const order = await clob.placeOrder({
          tokenId: token.slug,
          side:    'BUY',
          price:   token.priceAtBuy,
          size:    token.costUsdc,
        })
        polymarketOrderId = order.orderId
        console.log(`   ✅ Orden LIVE: ${token.slug} → ${order.orderId}`)
      } catch (err) {
        console.error(`   ❌ Error ejecutando orden ${token.slug}:`, err)
      }
    }

    const { error: tradeError } = await supabase
      .from('trades')
      .insert({
        prediction_id:        prediction.id,
        slug:                 token.slug,
        token_temp:           token.tempCelsius,
        position:             token.slot,           // 'a' | 'b'
        cost_usdc:            token.costUsdc,
        price_at_buy:         token.priceAtBuy,
        shares:               token.shares,
        simulated:            !isLive,
        polymarket_order_id:  polymarketOrderId,
      })

    if (tradeError) {
      console.error(`   ⚠️  Error guardando trade ${token.slot}:`, tradeError)
    }
  }

  console.log(`\n✅ Predicción completa para ${tomorrow}`)
  console.log(`   token_a = ${position.tokenA.tempCelsius}°C @ ${position.tokenA.priceAtBuy ?? 'N/A'}`)
  console.log(`   token_b = ${position.tokenB.tempCelsius}°C @ ${position.tokenB.priceAtBuy ?? 'N/A'}`)

  return prediction
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────
if (require.main === module) {
  runDailyPrediction().catch(console.error)
}
