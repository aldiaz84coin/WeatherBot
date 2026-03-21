// src/prediction/predict.ts
// Fase 2: genera la predicción diaria y construye la posición de 3 tokens

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { buildPosition } from './position'
import { ClobClient } from '../polymarket/clob'

const COST_DISTRIBUTION = { low: 0.20, mid: 0.40, high: 0.20 }

export async function runDailyPrediction() {
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const isLive = process.env.LIVE_TRADING === 'true'

  console.log(`\n🌡️  Predicción para: ${tomorrow}`)
  console.log(`   Modo: ${isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)

  // 1. Cargar pesos del último training_run exitoso
  const { data: latestRun } = await supabase
    .from('training_runs')
    .select('best_ensemble')
    .eq('passed', true)
    .order('run_at', { ascending: false })
    .limit(1)
    .single()

  const weights = latestRun?.best_ensemble ?? undefined
  const manager = await setupManager(weights)

  // 2. Obtener predicción del ensemble
  const ensemble = await manager.getEnsembleForecast(tomorrow)
  console.log(`   Ensemble: ${ensemble.ensembleTemp.toFixed(1)}°C`)
  console.log(`   Fuentes: ${JSON.stringify(ensemble.sourceTemps)}`)

  // 3. Construir los 3 tokens con precios de Polymarket
  const position = await buildPosition(ensemble.ensembleTemp, tomorrow)
  console.log(`   Tokens: [${position.tokens.map(t => `${t.tempCelsius}°`).join(', ')}]`)
  console.log(`   Coste total: ${position.totalCostUsdc} USDC`)
  console.log(`   Mercado disponible: ${position.marketAvailable}`)

  // 4. Guardar predicción en Supabase
  const { data: prediction, error } = await supabase
    .from('predictions')
    .insert({
      target_date:     tomorrow,
      ensemble_temp:   ensemble.ensembleTemp,
      source_temps:    ensemble.sourceTemps,
      token_low:       position.tokens[0].tempCelsius,
      token_mid:       position.tokens[1].tempCelsius,
      token_high:      position.tokens[2].tempCelsius,
      cost_low_usdc:   COST_DISTRIBUTION.low,
      cost_mid_usdc:   COST_DISTRIBUTION.mid,
      cost_high_usdc:  COST_DISTRIBUTION.high,
      simulated:       !isLive,
      ensemble_config: ensemble.weights,
    })
    .select()
    .single()

  if (error) {
    console.error('Error guardando predicción:', error)
    return
  }

  // 5. Guardar trades + ejecutar si LIVE
  const clob = isLive ? new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  ) : null

  for (const token of position.tokens) {
    let polymarketOrderId: string | null = null

    if (isLive && clob && token.priceAtBuy && position.marketAvailable) {
      try {
        const order = await clob.placeOrder({
          tokenId: token.slug,
          side: 'BUY',
          price: token.priceAtBuy,
          size: token.costUsdc,
        })
        polymarketOrderId = order.orderId
        console.log(`   ✅ Orden ejecutada: ${token.slug} → ${order.orderId}`)
      } catch (err) {
        console.error(`   ❌ Error ejecutando orden ${token.slug}:`, err)
      }
    }

    await supabase.from('trades').insert({
      prediction_id:       prediction.id,
      slug:                token.slug,
      token_temp:          token.tempCelsius,
      position:            token.position,
      cost_usdc:           token.costUsdc,
      price_at_buy:        token.priceAtBuy,
      shares:              token.shares,
      simulated:           !isLive,
      polymarket_order_id: polymarketOrderId,
    })
  }

  console.log(`✅ Predicción guardada (id: ${prediction.id})`)
  return prediction
}

if (require.main === module) {
  runDailyPrediction()
}
