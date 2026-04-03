// packages/bot/src/betting/live-switch.ts
// ─────────────────────────────────────────────────────────────────────────────
// Transición en caliente de modo simulado → live.
//
// Flujo al activar live:
//   1. El dashboard setea betting_mode="live" Y pending_live_switch=true
//   2. El scheduler (cada 30 s) detecta el flag y llama checkAndExecuteLiveSwitch()
//   3. Se cancela el ciclo simulado abierto para mañana (si existe)
//   4. Se genera una predicción fresca en ese momento con el ensemble actual
//   5. Se aplica sesgo N y se construye la posición de 2 tokens
//   6. Se ejecutan órdenes REALES en Polymarket a 1× stake base (sin Martingala)
//   7. Se guardan predicción + trades + cycle en Supabase como simulated=false
//   8. Los ciclos siguientes corren normalmente desde engine.ts a las 00:30
//      con los parámetros configurados (Martingala, etc.)
// ─────────────────────────────────────────────────────────────────────────────

import { format, addDays }  from 'date-fns'
import { supabase }          from '../db/supabase'
import { BotEventLogger }    from './logger'
import { getStakeConfig, getConfigValue, setConfigValue } from './config'
import { getCurrentBias }    from './bias-optimizer'
import { setupManager }      from '../training/setup'
import { buildPosition }     from '../prediction/position'
import { ClobClient }        from '../polymarket/clob'

const logger = new BotEventLogger('LIVE-SWITCH')

// ─── Entrypoint — llamado desde el scheduler cada 30 s ───────────────────────

export async function checkAndExecuteLiveSwitch(): Promise<void> {
  const pending = await getConfigValue<boolean>('pending_live_switch')
  if (!pending) return

  await logger.log(
    'info', 'info',
    '🔔 Flag pending_live_switch detectado — iniciando transición a modo LIVE'
  )

  try {
    await executeLiveSwitch()
  } catch (err) {
    await logger.error('Error durante la transición live', err)
  } finally {
    // Limpiar flag siempre, incluso si hubo error parcial
    await setConfigValue('pending_live_switch', false)
    await logger.log('info', 'info', '🏁 Flag pending_live_switch limpiado')
  }
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function executeLiveSwitch(): Promise<void> {
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const stake    = await getStakeConfig()

  // ── 1. Log: config completa activa al activar modo live ───────────────────
  await logLiveModeConfig(tomorrow, stake)

  // ── 2. Cancelar ciclo simulado abierto para mañana (si existe) ────────────
  await cancelSimulatedCycle(tomorrow)

  // ── 3. Cargar pesos de fuentes desde Supabase ─────────────────────────────
  const { data: sourcesData } = await supabase
    .from('weather_sources')
    .select('slug, weight')
    .eq('active', true)

  const customWeights: Record<string, number> = sourcesData
    ? Object.fromEntries(sourcesData.map(s => [s.slug, s.weight ?? 0]))
    : {}

  // ── 4. Leer sesgo N ───────────────────────────────────────────────────────
  const biasN = await getCurrentBias()

  // ── 5. Generar predicción fresca con el ensemble actual ───────────────────
  await logger.log('info', 'prediction',
    `🌡️  Generando predicción fresca para ${tomorrow}…`
  )

  const manager     = await setupManager(customWeights)
  const ensembleRes = await manager.getEnsembleForecast(tomorrow)
  const rawEnsemble = ensembleRes.ensembleTemp

  if (!rawEnsemble) {
    await logger.error(`No se pudo obtener ensemble para ${tomorrow} — transición abortada`)
    return
  }

  const adjustedEnsemble = rawEnsemble + biasN

  const signN = biasN >= 0 ? '+' : ''
  await logger.log('info', 'prediction',
    `Ensemble: ${rawEnsemble.toFixed(2)}°C  ${signN}${biasN.toFixed(2)}°C (sesgo N)  →  ajustado: ${adjustedEnsemble.toFixed(2)}°C`,
    { rawEnsemble, biasN, adjustedEnsemble }
  )

  // ── 6. Construir posición de 2 tokens ────────────────────────────────────
  const position = await buildPosition(adjustedEnsemble, tomorrow)
  const tokenA   = position.tokenA.tempCelsius
  const tokenB   = position.tokenB.tempCelsius
  const priceA   = position.tokenA.priceAtBuy
  const priceB   = position.tokenB.priceAtBuy

  await logger.log('info', 'prediction',
    `Tokens: ${tokenA}°C / ${tokenB}°C | ` +
    `Precios: ${priceA ? (priceA * 100).toFixed(1) : '?'}¢ / ${priceB ? (priceB * 100).toFixed(1) : '?'}¢`
  )

  // ── 7. Calcular stake 1× (sin Martingala — primer ciclo live siempre base) ─
  const liveStake = stake.baseStake   // siempre 1×, independiente de la racha
  const priceSum  = (priceA ?? 0) + (priceB ?? 0)
  const shares    = priceSum > 0 ? liveStake / priceSum : 0
  const costA     = shares * (priceA ?? 0)
  const costB     = shares * (priceB ?? 0)

  await logger.log('info', 'prediction',
    `Stake: $${liveStake.toFixed(2)} (1× base — primer ciclo live) | ` +
    `Shares: ${shares.toFixed(4)} c/token`
  )

  // ── 8. Persistir predicción en Supabase ──────────────────────────────────
  const { data: prediction, error: predError } = await supabase
    .from('predictions')
    .insert({
      target_date:       tomorrow,
      predicted_at:      new Date().toISOString(),
      ensemble_temp:     rawEnsemble,
      bias_applied:      biasN,
      ensemble_adjusted: adjustedEnsemble,
      source_temps:      ensembleRes.sourceTemps,
      ensemble_config:   ensembleRes.weights,
      opt_weights:       customWeights,
      token_a:           tokenA,
      token_b:           tokenB,
      cost_a_usdc:       costA,
      cost_b_usdc:       costB,
      stake_usdc:        liveStake,
      simulated:         false,   // ← LIVE
      settled:           false,
      comparison_source: false,
      token_low: null, token_mid: null, token_high: null,
      cost_low_usdc: null, cost_mid_usdc: null, cost_high_usdc: null,
    })
    .select()
    .single()

  if (predError || !prediction) {
    await logger.error(`Error guardando predicción live: ${predError?.message}`, predError)
    return
  }

  // ── 9. Ejecutar órdenes reales via CLOB ──────────────────────────────────
  const clob = new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  )

  type OrderResult = {
    slot:      'a' | 'b'
    tokenTemp: number
    slug:      string
    orderId:   string | null
    priceUsed: number
    costUsdc:  number
    shares:    number
    success:   boolean
    errorMsg?: string
  }

  const orderDefs = [
    { slot: 'a' as const, token: position.tokenA, tempCelsius: tokenA, cost: costA },
    { slot: 'b' as const, token: position.tokenB, tempCelsius: tokenB, cost: costB },
  ]

  const results: OrderResult[] = []

  for (const def of orderDefs) {
    let orderId: string | null = null
    let success = false
    let errorMsg: string | undefined

    const price = def.token.priceAtBuy

    if (!price) {
      errorMsg = 'Precio no disponible — mercado no activo aún'
      await logger.log('warn', 'prediction',
        `   ⚠️  Token ${def.tempCelsius}°C (${def.slot}): ${errorMsg}`
      )
    } else {
      try {
        const order = await clob.placeOrder({
          tokenId: def.token.tokenId,
          side:    'BUY',
          price,
          size:    def.cost,
        })
        orderId = order.orderId
        success = true

        await logger.log('success', 'prediction',
          `   ✅ Orden REAL ejecutada: ${def.tempCelsius}°C (${def.slot}) ` +
          `@ ${(price * 100).toFixed(1)}¢ · $${def.cost.toFixed(2)} USDC → orderId: ${orderId}`
        )
      } catch (err: any) {
        errorMsg = err?.message ?? String(err)
        await logger.error(
          `   ❌ Error orden ${def.tempCelsius}°C (${def.slot}): ${errorMsg}`,
          err
        )
      }
    }

    results.push({
      slot:      def.slot,
      tokenTemp: def.tempCelsius,
      slug:      def.token.slug,
      orderId,
      priceUsed: price ?? 0,
      costUsdc:  def.cost,
      shares,
      success,
      errorMsg,
    })
  }

  // ── 10. Persistir trades en Supabase ─────────────────────────────────────
  const resA = results.find(r => r.slot === 'a')!
  const resB = results.find(r => r.slot === 'b')!

  const { error: tradesError } = await supabase
    .from('trades')
    .insert([
      {
        prediction_id:       prediction.id,
        slug:                position.tokenA.slug,
        token_temp:          tokenA,
        position:            'a',
        cost_usdc:           costA,
        price_at_buy:        priceA,
        shares,
        simulated:           false,
        status:              'open',
        polymarket_order_id: resA.orderId,
      },
      {
        prediction_id:       prediction.id,
        slug:                position.tokenB.slug,
        token_temp:          tokenB,
        position:            'b',
        cost_usdc:           costB,
        price_at_buy:        priceB,
        shares,
        simulated:           false,
        status:              'open',
        polymarket_order_id: resB.orderId,
      },
    ])

  if (tradesError) {
    await logger.error(`Error guardando trades: ${tradesError.message}`, tradesError)
  }

  // ── 11. Crear betting_cycle live con multiplier=1 ─────────────────────────
  const { data: cycle, error: cycleError } = await supabase
    .from('betting_cycles')
    .insert({
      target_date:     tomorrow,
      prediction_id:   prediction.id,
      base_stake_usdc: liveStake,  // ← 1× base (sin Martingala en el primer ciclo live)
      stake_usdc:      liveStake,
      multiplier:      1,          // ← siempre 1× en el primer ciclo live
      status:          'open',
      simulated:       false,      // ← LIVE
    })
    .select()
    .single()

  if (cycleError) {
    await logger.error(`Error creando betting_cycle: ${cycleError.message}`, cycleError)
    return
  }

  // ── 12. Log resumen final ─────────────────────────────────────────────────
  const successCount = results.filter(r => r.success).length
  const failCount    = results.filter(r => !r.success).length
  const orderIds     = results.map(r => r.orderId ?? '(FAILED)').join(', ')

  await logger.log(
    successCount === 2 ? 'success' : failCount === 2 ? 'error' : 'warn',
    'prediction',
    `🔴 TRANSICIÓN LIVE COMPLETADA — ${tomorrow}: ` +
    `${successCount}/2 órdenes ejecutadas | ` +
    `stake: $${liveStake.toFixed(2)} (1× base) | ` +
    `tokens: ${tokenA}°/${tokenB}° | ` +
    `orderIds: [${orderIds}]` +
    (failCount > 0 ? ` | ⚠️ ${failCount} orden(es) fallaron` : ''),
    {
      targetDate:    tomorrow,
      cycleId:       cycle.id,
      predictionId:  prediction.id,
      successCount,
      failCount,
      stake:         liveStake,
      multiplier:    1,
      tokenA, tokenB, priceA, priceB, shares,
      orders:        results,
      note:          'Siguiente ciclo (00:30) aplicará Martingala configurada normalmente',
    }
  )
}

// ─── Cancelar ciclo simulado de mañana ───────────────────────────────────────
// Marca el ciclo y sus trades como cancelados para que el engine no los duplique

async function cancelSimulatedCycle(tomorrow: string): Promise<void> {
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .select('id, prediction_id')
    .eq('target_date', tomorrow)
    .eq('simulated', true)
    .eq('status', 'open')
    .maybeSingle()

  if (cycleErr) {
    await logger.error(`Error buscando ciclo simulado: ${cycleErr.message}`, cycleErr)
    return
  }

  if (!cycle) {
    await logger.log('info', 'info',
      `ℹ️  No había ciclo simulado abierto para ${tomorrow} — se creará uno live nuevo`
    )
    return
  }

  // Cancelar trades del ciclo simulado

// Eliminar trades del ciclo simulado (FK antes que la predicción)
const { error: tradesErr } = await supabase
  .from('trades')
  .delete()
  .eq('prediction_id', cycle.prediction_id)
  .eq('simulated', true)

if (tradesErr) {
  await logger.error(`Error eliminando trades simulados: ${tradesErr.message}`, tradesErr)
}

// Eliminar la predicción para liberar el UNIQUE(target_date)
const { error: predErr } = await supabase
  .from('predictions')
  .delete()
  .eq('id', cycle.prediction_id)
  .eq('simulated', true)

if (predErr) {
  // Fallback: si hay FK a results no se puede borrar, renombrar la fecha
  await logger.warn(`No se pudo eliminar predicción simulada: ${predErr.message}`)
  await supabase
    .from('predictions')
    .update({ settled: true })
    .eq('id', cycle.prediction_id)
}
  
  // Marcar ciclo como skipped
  const { error: cycleUpdateErr } = await supabase
    .from('betting_cycles')
    .update({ status: 'skipped' })
    .eq('id', cycle.id)

  if (cycleUpdateErr) {
    await logger.error(`Error cancelando ciclo simulado: ${cycleUpdateErr.message}`, cycleUpdateErr)
  } else {
    await logger.log('info', 'info',
      `🗑️  Ciclo simulado ${cycle.id} para ${tomorrow} marcado como skipped — reemplazado por ciclo live`
    )
  }
}

// ─── Log de configuración completa al activar live ───────────────────────────

async function logLiveModeConfig(
  targetDate: string,
  stake: Awaited<ReturnType<typeof getStakeConfig>>
): Promise<void> {
  try {
    const [sourcesRes, biasN] = await Promise.all([
      supabase
        .from('weather_sources')
        .select('slug, weight, active')
        .eq('active', true)
        .order('weight', { ascending: false }),
      getCurrentBias(),
    ])

    const sources = sourcesRes.data ?? []
    const signN   = biasN >= 0 ? '+' : ''

    const weightsSummary = sources
      .map(s => `${s.slug}=${((s.weight ?? 0) * 100).toFixed(0)}%`)
      .join(', ')

    const capInfo = stake.cappedAtMax ? ` ⚠️ tope máx $${stake.maxStake}` : ''

    await logger.log(
      'success',
      'weight_update',
      `🔴 MODO LIVE ACTIVADO ─── Configuración para ${targetDate}\n` +
      `   stake:    $${stake.baseStake} (1× base — Martingala desde el 2º ciclo)${capInfo}\n` +
      `   max:      $${stake.maxStake} | racha pérdidas: ${stake.consecutiveLosses}\n` +
      `   bias N:   ${signN}${biasN.toFixed(2)}°C\n` +
      `   pesos:    ${weightsSummary || '(sin fuentes activas)'}`,
      {
        targetDate,
        bettingMode:       'live',
        stake:             stake.baseStake,
        baseStake:         stake.baseStake,
        multiplier:        1,
        maxStake:          stake.maxStake,
        cappedAtMax:       stake.cappedAtMax,
        consecutiveLosses: stake.consecutiveLosses,
        biasN,
        weights: Object.fromEntries(sources.map(s => [s.slug, s.weight])),
      }
    )
  } catch (err) {
    console.error('[LIVE-SWITCH] Error logueando config activa:', err)
  }
}

// ─── Helper público: fetch precios frescos de Polymarket ─────────────────────

export async function fetchFreshPricesForDate(date: string): Promise<Record<string, number> | null> {
  try {
    const months = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december',
    ]
    const d       = new Date(date + 'T12:00:00')
    const dateStr = `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
    const slug    = `highest-temperature-in-madrid-on-${dateStr}`

    const res = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (!res.ok) return null

    const events = await res.json()
    if (!Array.isArray(events) || events.length === 0) return null

    const markets: any[] = events[0].markets ?? []
    const priceMap: Record<string, number> = {}

    for (const m of markets) {
      try {
        const tokenIds = JSON.parse(m.clobTokenIds ?? '[]')
        const prices   = JSON.parse(m.outcomePrices ?? '[]')
        const tokenId  = tokenIds[0]
        const price    = parseFloat(prices[0])
        if (tokenId && !isNaN(price)) {
          priceMap[tokenId] = price
        }
      } catch { /* ignorar mercados mal formados */ }
    }

    return Object.keys(priceMap).length > 0 ? priceMap : null
  } catch {
    return null
  }
}
