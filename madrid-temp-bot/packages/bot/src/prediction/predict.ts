// src/prediction/predict.ts
// Fase 2: genera la predicción diaria y construye la posición de 3 tokens

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { GammaClient } from '../polymarket/gamma'

const COST_DISTRIBUTION = { low: 0.20, mid: 0.40, high: 0.20 }  // total = 0.80

export async function runDailyPrediction() {
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const isLive = process.env.LIVE_TRADING === 'true'

  console.log(`\n🌡️  Predicción para: ${tomorrow}`)
  console.log(`   Modo: ${isLive ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)

  // 1. Cargar pesos óptimos del último training_run exitoso
  const { data: latestRun } = await supabase
    .from('training_runs')
    .select('best_ensemble')
    .eq('passed', true)
    .order('run_at', { ascending: false })
    .limit(1)
    .single()

  const weights = latestRun?.best_ensemble ?? undefined
  const manager = await setupManager(weights)

  // 2. Obtener ensemble
  const ensemble = await manager.getEnsembleForecast(tomorrow)
  console.log(`   Ensemble: ${ensemble.ensembleTemp.toFixed(1)}°C`)
  console.log(`   Fuentes: ${JSON.stringify(ensemble.sourceTemps)}`)

  // 3. Construir los 3 tokens
  const pred = Math.round(ensemble.ensembleTemp)
  const tokens = {
    low:  pred - 1,
    mid:  pred,
    high: pred + 1,
  }
  console.log(`   Tokens: [${tokens.low}°, ${tokens.mid}°, ${tokens.high}°]`)

  // 4. Verificar precios en Polymarket
  const gamma = new GammaClient()
  const prices: Record<string, number | null> = {}
  for (const [pos, temp] of Object.entries(tokens)) {
    const daySlug = `highest-temperature-in-madrid-on-${format(addDays(new Date(), 1), 'MMMM-d-yyyy').toLowerCase()}`
    // Los mercados reales usarán slugs específicos por temperatura
    prices[pos] = await gamma.getTokenPrice(daySlug)
  }

  // 5. Guardar predicción en Supabase
  const { data: prediction, error } = await supabase
    .from('predictions')
    .insert({
      target_date:     tomorrow,
      ensemble_temp:   ensemble.ensembleTemp,
      source_temps:    ensemble.sourceTemps,
      token_low:       tokens.low,
      token_mid:       tokens.mid,
      token_high:      tokens.high,
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

  // 6. Guardar trades (simulados o reales)
  for (const [position, temp] of Object.entries(tokens)) {
    await supabase.from('trades').insert({
      prediction_id:  prediction.id,
      slug:           `highest-temperature-in-madrid-${temp}c-on-${format(addDays(new Date(), 1), 'MMMM-d-yyyy').toLowerCase()}`,
      token_temp:     temp,
      position,
      cost_usdc:      COST_DISTRIBUTION[position as keyof typeof COST_DISTRIBUTION],
      price_at_buy:   prices[position],
      shares:         prices[position] ? COST_DISTRIBUTION[position as keyof typeof COST_DISTRIBUTION] / prices[position]! : null,
      simulated:      !isLive,
    })
  }

  console.log(`✅ Predicción guardada (id: ${prediction.id})`)
  return prediction
}

if (require.main === module) {
  runDailyPrediction()
}
