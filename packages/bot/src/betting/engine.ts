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

  // ── LOG: Configuración activa al inicio del ciclo ─────────────────────────
  await logActiveConfig(tomorrow, stake)

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
    await createCycleFromExistingPrediction(existingPred.id, tomorrow, stake, isSimulated)
    return
  }

  // ── 1. Leer pesos de fuentes desde Supabase ───────────────────────────────
  const { data: sourcesData } = await supabase
    .from('weather_sources')
    .select('slug, weight')
    .eq('active', true)

  const customWeights: Record<string, number> = sourcesData
    ? Object.fromEntries(sourcesData.map(s => [s.slug, s.weight ?? 0]))
    : {}

  // ── 2. Leer sesgo N desde Supabase ───────────────────────────────────────
  const biasN = await getCurrentBias()

  // ── 3. Construir ensemble con fuentes registradas ─────────────────────────
  const manager     = await setupManager(customWeights)
  const ensembleRes = await manager.getEnsemble(tomorrow)

  const rawEnsemble = ensembleRes?.ensemble ?? null

  if (!rawEnsemble) {
    await logger.error(`No se pudo obtener ensemble para ${tomorrow}`)
    return
  }

  // ── 4. Aplicar corrección de sesgo ────────────────────────────────────────
  const adjustedEnsemble = rawEnsemble + biasN

  await logger.log('info', 'prediction',
    `Ensemble: ${rawEnsemble.toFixed(2)}°C  +  sesgo N=${biasN >= 0 ? '+' : ''}${biasN}°C  →  ajustado: ${adjustedEnsemble.toFixed(2)}°C`,
    { rawEnsemble, biasN, adjustedEnsemble }
  )

  // ── 5. Obtener precios de Polymarket ─────────────────────────────────────
  const position = await buildPosition(tomorrow, adjustedEnsemble)

  if (!position) {
    await logger.error(`No se pudo construir posición para ${tomorrow}`)
    return
  }

  const { tokenA, tokenB, priceA, priceB } = position

  // ── 6. Calcular shares ───────────────────────────────────────────────────
  const totalStake = stake.baseStake * stake.multiplier
  const shares     = priceA + priceB > 0 ? totalStake / (priceA + priceB) : 0
  const costA      = shares * priceA
  const costB      = shares * priceB

  // ── 7. Persistir predicción ───────────────────────────────────────────────
  const { data: prediction, error: predError } = await supabase
    .from('predictions')
    .insert({
      target_date:    tomorrow,
      predicted_at:   new Date().toISOString(),
      ensemble_temp:  rawEnsemble,
      bias_applied:   biasN,
      ensemble_adjusted: adjustedEnsemble,
      source_temps:   ensembleRes?.sourcePredictions ?? {},
      ensemble_config: customWeights,
      token_a:        tokenA,
      token_b:        tokenB,
      cost_a_usdc:    costA,
      cost_b_usdc:    costB,
      stake_usdc:     totalStake,
      simulated:      isSimulated,
      settled:        false,
      comparison_source: false,
      // Columnas legacy
      token_low:  null, token_mid:  null, token_high: null,
      cost_low_usdc: null, cost_mid_usdc: null, cost_high_usdc: null,
    })
    .select()
    .single()

  if (predError) {
    await logger.error(`Error guardando predicción: ${predError.message}`, predError)
    return
  }

  // ── 8. Persistir trades ───────────────────────────────────────────────────
  const { error: tradesError } = await supabase
    .from('trades')
    .insert([
      {
        prediction_id: prediction.id,
        slug:          position.slugA,
        token_temp:    tokenA,
        position:      'a',
        cost_usdc:     costA,
        price_at_buy:  priceA,
        shares,
        simulated:     isSimulated,
        status:        'open',
      },
      {
        prediction_id: prediction.id,
        slug:          position.slugB,
        token_temp:    tokenB,
        position:      'b',
        cost_usdc:     costB,
        price_at_buy:  priceB,
        shares,
        simulated:     isSimulated,
        status:        'open',
      },
    ])

  if (tradesError) {
    await logger.error(`Error guardando trades: ${tradesError.message}`, tradesError)
    return
  }

  // ── 9. Crear betting_cycle ────────────────────────────────────────────────
  const { data: cycle, error: cycleError } = await supabase
    .from('betting_cycles')
    .insert({
      target_date:   tomorrow,
      prediction_id: prediction.id,
      stake_usdc:    totalStake,
      multiplier:    stake.multiplier,
      status:        'open',
      simulated:     isSimulated,
    })
    .select()
    .single()

  if (cycleError) {
    await logger.error(`Error creando betting_cycle: ${cycleError.message}`, cycleError)
    return
  }

  // ── 10. Log resumen ───────────────────────────────────────────────────────
  const signN = biasN >= 0 ? '+' : ''
  await logger.log('success', 'prediction',
    `✅ Ciclo creado — ${tomorrow} | ` +
    `Tokens: ${tokenA}°/${tokenB}° | ` +
    `Stake: $${totalStake.toFixed(2)} (×${stake.multiplier}) | ` +
    `Precios: ${(priceA * 100).toFixed(0)}¢/${(priceB * 100).toFixed(0)}¢ | ` +
    `Modo: ${stake.bettingMode}`,
    {
      cycleId:       cycle.id,
      predictionId:  prediction.id,
      tokenA, tokenB, priceA, priceB,
      shares:        parseFloat(shares.toFixed(4)),
      stake:         totalStake,
      biasN,
    }
  )
}

// ─── Log de configuración activa ─────────────────────────────────────────────

async function logActiveConfig(
  targetDate: string,
  stake: Awaited<ReturnType<typeof getStakeConfig>>,
): Promise<void> {
  try {
    // Leer bias actual
    const biasN = await getCurrentBias()

    // Leer pesos de fuentes activas
    const { data: sourcesData } = await supabase
      .from('weather_sources')
      .select('slug, weight')
      .eq('active', true)
      .order('weight', { ascending: false })

    const weightsSummary = (sourcesData ?? [])
      .map(s => `${s.slug}=${((s.weight ?? 0) * 100).toFixed(0)}%`)
      .join(', ')

    const signN = biasN >= 0 ? '+' : ''

    await logger.log(
      'info',
      'weight_update',
      `📋 Config activa para ${targetDate}: ` +
      `bias N=${signN}${biasN.toFixed(1)}°C | ` +
      `stake base=$${stake.baseStake} ×${stake.multiplier} | ` +
      `modo=${stake.bettingMode} | ` +
      `pesos=[${weightsSummary}]`,
      {
        targetDate,
        biasN,
        baseStake:   stake.baseStake,
        multiplier:  stake.multiplier,
        bettingMode: stake.bettingMode,
        weights:     Object.fromEntries((sourcesData ?? []).map(s => [s.slug, s.weight])),
      }
    )
  } catch (err) {
    // No es fatal — el ciclo continúa aunque falle el log de config
    console.error('[ENGINE] Error logueando config activa:', err)
  }
}

// ─── Crear ciclo desde predicción existente ───────────────────────────────────

async function createCycleFromExistingPrediction(
  predictionId: string,
  tomorrow:     string,
  stake:        Awaited<ReturnType<typeof getStakeConfig>>,
  isSimulated:  boolean,
): Promise<void> {
  const totalStake = stake.baseStake * stake.multiplier

  const { error } = await supabase
    .from('betting_cycles')
    .insert({
      target_date:   tomorrow,
      prediction_id: predictionId,
      stake_usdc:    totalStake,
      multiplier:    stake.multiplier,
      status:        'open',
      simulated:     isSimulated,
    })

  if (error) {
    await logger.error(`Error creando cycle desde predicción existente: ${error.message}`, error)
  } else {
    await logger.log('success', 'prediction',
      `✅ Ciclo creado desde predicción existente — ${tomorrow} | Stake: $${totalStake} (×${stake.multiplier})`
    )
  }
}
