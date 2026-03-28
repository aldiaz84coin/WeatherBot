// packages/bot/src/betting/engine.ts
// ──────────────────────────────────────────────────────────────────────────────
// Motor principal de apuestas — se ejecuta cada día a las 00:30 Madrid.
//
// Flujo:
//   1. Leer stake actual (base × multiplicador, respetando máximo)
//   2. Consultar las fuentes con los pesos aprendidos → ensemble_temp
//   3. Aplicar sesgo N: ensemble_ajustado = ensemble + N
//   4. Calcular token_a = ceil(ensemble_ajustado), token_b = ceil+1
//   5. Repartir el stake de forma que se compren el MISMO nº de shares
//      de cada token: shares = stake / (priceA + priceB)
//   6. Guardar predicción + trades en Supabase (tablas existentes)
//   7. Crear fila en betting_cycles para tracking de la Martingala
//   8. Loggear todo en bot_events
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import { format, addDays } from 'date-fns'
import { supabase } from '../db/supabase'
import { setupManager } from '../training/setup'
import { buildPosition } from '../prediction/position'
import { BotEventLogger } from './logger'
import { getStakeConfig } from './config'
import { getCurrentBias } from './bias-optimizer'

const logger = new BotEventLogger('ENGINE')

// ─── Runner principal ─────────────────────────────────────────────────────────

export async function runBettingCycle(targetDate?: string): Promise<void> {
  // targetDate permite ejecutar el ciclo para una fecha concreta (útil en tests)
  const tomorrow   = targetDate ?? format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const stake      = await getStakeConfig()
  const isSimulated = stake.bettingMode !== 'live'

  await logger.log('info', 'prediction',
    `──── Ciclo de apuesta ${tomorrow} ────`,
    { mode: stake.bettingMode }
  )

  // ── Guard: ¿ya existe ciclo para esta fecha? ──────────────────────────────
  const { data: existingCycle } = await supabase
    .from('betting_cycles')
    .select('id, status')
    .eq('target_date', tomorrow)
    .maybeSingle()

  if (existingCycle) {
    await logger.log('warn', 'info',
      `Ciclo para ${tomorrow} ya existe (${existingCycle.status}) — saltando`,
      { cycleId: existingCycle.id }
    )
    return
  }

  // ── Guard: ¿ya existe predicción para mañana? ─────────────────────────────
  const { data: existingPred } = await supabase
    .from('predictions')
    .select('id')
    .eq('target_date', tomorrow)
    .maybeSingle()

  if (existingPred) {
    await logger.log('warn', 'info',
      `Predicción para ${tomorrow} ya existe (id: ${existingPred.id}) — reutilizando`,
    )
    // Crear el betting_cycle usando la predicción existente
    await createCycleFromExistingPrediction(existingPred.id, tomorrow, stake, isSimulated)
    return
  }

  // ── 1. Stake ──────────────────────────────────────────────────────────────
  await logger.log('info', 'prediction',
    `Stake: ${stake.baseStake} USDC × ${stake.multiplier} = ${stake.currentStake} USDC` +
    (stake.cappedAtMax ? ' ⚠️ TOPE MÁXIMO' : ''),
    { ...stake }
  )

  // ── 2. Pesos del ensemble ─────────────────────────────────────────────────
  const manager = await setupManager()

  const { data: latestRun } = await supabase
    .from('training_runs')
    .select('best_ensemble')
    .eq('passed', true)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const weightsUsed = latestRun?.best_ensemble ?? null
  if (weightsUsed) {
    manager.setWeights(weightsUsed)
    await logger.info(`Pesos cargados del último training_run`, { weightsUsed })
  } else {
    await logger.warn(`Sin training_run válido — usando pesos por defecto de weather_sources`)
  }

  // ── 3. Predicción de temperatura ─────────────────────────────────────────
  let sourceTemps: Record<string, number> = {}
  let ensembleRaw: number

  try {
    const forecast = await manager.getEnsembleForecast(tomorrow)
    sourceTemps    = forecast.sourceTemps
    ensembleRaw    = forecast.ensembleTemp
  } catch (err) {
    await logger.error(`Error obteniendo predicciones de fuentes`, err)
    // Registrar ciclo con error y abortar
    await supabase.from('betting_cycles').insert({
      target_date:     tomorrow,
      base_stake_usdc: stake.baseStake,
      multiplier:      stake.multiplier,
      stake_usdc:      stake.currentStake,
      capped_at_max:   stake.cappedAtMax,
      status:          'error',
      simulated:       isSimulated,
      source_temps:    {},
      weights_used:    weightsUsed,
    })
    return
  }

  // ── 3b. Aplicar sesgo N ───────────────────────────────────────────────────
  // N = mean(actual - ensemble) calculado diariamente a las 08:00.
  // ensemble_ajustado = ensemble + N  →  ceil(ensemble_ajustado) = token_a
  const biasN       = await getCurrentBias()
  const ensembleTemp = parseFloat((ensembleRaw + biasN).toFixed(4))
  const nSign        = biasN >= 0 ? '+' : ''

  await logger.log('info', 'prediction',
    `Ensemble: ${ensembleRaw.toFixed(3)}°C  +  N(${nSign}${biasN.toFixed(3)}°C)  =  ${ensembleTemp.toFixed(3)}°C para ${tomorrow}`,
    { ensembleRaw, biasN, ensembleTemp, sourceTemps }
  )

  // ── 4. Construir posición (con ensemble corregido) ────────────────────────
  // token_a = ceil(ensemble + N), token_b = ceil(ensemble + N) + 1
  let position: Awaited<ReturnType<typeof buildPosition>>

  try {
    position = await buildPosition(ensembleTemp, tomorrow)
  } catch (err) {
    await logger.error(`Error construyendo posición`, err)
    await supabase.from('betting_cycles').insert({
      target_date:     tomorrow,
      base_stake_usdc: stake.baseStake,
      multiplier:      stake.multiplier,
      stake_usdc:      stake.currentStake,
      capped_at_max:   stake.cappedAtMax,
      ensemble_temp:   ensembleTemp,
      status:          'error',
      simulated:       isSimulated,
      source_temps:    sourceTemps,
      weights_used:    weightsUsed,
    })
    return
  }

  // ── 5. Reparto de stake — mismo nº de shares para cada token ─────────────
  //
  //   N      = stake / (priceA + priceB)
  //   costA  = N × priceA
  //   costB  = N × priceB
  //   costA + costB ≈ stake  ✓
  //
  const priceA = position.tokenA.priceAtBuy ?? 0.5
  const priceB = position.tokenB.priceAtBuy ?? 0.5
  const shares = parseFloat((stake.currentStake / (priceA + priceB)).toFixed(6))
  const costA  = parseFloat((shares * priceA).toFixed(4))
  const costB  = parseFloat((shares * priceB).toFixed(4))

  await logger.info(
    `Posición: ${position.tokenA.tempCelsius}°C (${priceA.toFixed(3)}) + ` +
    `${position.tokenB.tempCelsius}°C (${priceB.toFixed(3)}) — ` +
    `${shares.toFixed(4)} shares c/u — total: ${(costA + costB).toFixed(4)} USDC`,
    { priceA, priceB, shares, costA, costB }
  )

  // ── 6. Guardar predicción en la tabla predictions ─────────────────────────
  const { data: prediction, error: predErr } = await supabase
    .from('predictions')
    .insert({
      target_date:    tomorrow,
      predicted_at:   new Date().toISOString(),
      ensemble_temp:  parseFloat(ensembleTemp.toFixed(2)),
      source_temps:   sourceTemps,
      token_a:        position.tokenA.tempCelsius,
      token_b:        position.tokenB.tempCelsius,
      cost_a_usdc:    costA,
      cost_b_usdc:    costB,
      stake_usdc:     stake.currentStake,
      simulated:      isSimulated,
      ensemble_config: weightsUsed,
    })
    .select('id')
    .single()

  if (predErr || !prediction) {
    await logger.error(`Error guardando predicción: ${predErr?.message}`)
    return
  }

  // ── 7. Guardar trades ─────────────────────────────────────────────────────
  const tokensToInsert = [
    { token: position.tokenA, slot: 'a', cost: costA },
    { token: position.tokenB, slot: 'b', cost: costB },
  ]

  for (const { token, slot, cost } of tokensToInsert) {
    const { error: tradeErr } = await supabase.from('trades').insert({
      prediction_id:  prediction.id,
      slug:           token.slug,
      token_temp:     token.tempCelsius,
      position:       slot,
      cost_usdc:      cost,
      price_at_buy:   token.priceAtBuy,
      shares:         shares,
      simulated:      isSimulated,
      status:         'open',
    })
    if (tradeErr) {
      await logger.warn(`Error guardando trade ${slot}: ${tradeErr.message}`)
    }
  }

  // ── 8. Crear betting_cycle ────────────────────────────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .insert({
      target_date:     tomorrow,
      base_stake_usdc: stake.baseStake,
      multiplier:      stake.multiplier,
      stake_usdc:      stake.currentStake,
      capped_at_max:   stake.cappedAtMax,
      ensemble_temp:   parseFloat(ensembleTemp.toFixed(2)),
      token_a_temp:    position.tokenA.tempCelsius,
      token_b_temp:    position.tokenB.tempCelsius,
      price_a:         priceA,
      price_b:         priceB,
      shares,
      cost_a_usdc:     costA,
      cost_b_usdc:     costB,
      prediction_id:   prediction.id,
      status:          'open',
      simulated:       isSimulated,
      source_temps:    sourceTemps,
      weights_used:    weightsUsed,
    })
    .select('id')
    .single()

  if (cycleErr || !cycle) {
    await logger.error(`Error creando betting_cycle: ${cycleErr?.message}`)
    return
  }

  await logger.log('success', 'prediction',
    `✅ Ciclo abierto para ${tomorrow} — ` +
    `${position.tokenA.tempCelsius}°C + ${position.tokenB.tempCelsius}°C @ ${shares.toFixed(4)} shares`,
    {
      cycleId:  cycle.id,
      predId:   prediction.id,
      stake:    stake.currentStake,
      tokens:   `${position.tokenA.tempCelsius}°C / ${position.tokenB.tempCelsius}°C`,
    },
    cycle.id
  )
}

// ─── Reutilizar predicción existente ────────────────────────────────────────

async function createCycleFromExistingPrediction(
  predictionId: string,
  tomorrow:     string,
  stake:        Awaited<ReturnType<typeof getStakeConfig>>,
  isSimulated:  boolean,
): Promise<void> {
  const { data: pred } = await supabase
    .from('predictions')
    .select('ensemble_temp, token_a, token_b, cost_a_usdc, cost_b_usdc, source_temps, ensemble_config')
    .eq('id', predictionId)
    .single()

  if (!pred) return

  await supabase.from('betting_cycles').insert({
    target_date:     tomorrow,
    base_stake_usdc: stake.baseStake,
    multiplier:      stake.multiplier,
    stake_usdc:      stake.currentStake,
    capped_at_max:   stake.cappedAtMax,
    ensemble_temp:   pred.ensemble_temp,
    token_a_temp:    pred.token_a,
    token_b_temp:    pred.token_b,
    cost_a_usdc:     pred.cost_a_usdc,
    cost_b_usdc:     pred.cost_b_usdc,
    prediction_id:   predictionId,
    status:          'open',
    simulated:       isSimulated,
    source_temps:    pred.source_temps,
    weights_used:    pred.ensemble_config,
  })
}

// ─── Entrypoint directo ───────────────────────────────────────────────────────

if (require.main === module) {
  runBettingCycle().catch(err => {
    console.error('Fatal en runBettingCycle:', err)
    process.exit(1)
  })
}
