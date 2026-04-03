// packages/bot/src/betting/live-switch.ts
// ─────────────────────────────────────────────────────────────────────────────
// Transición en caliente de modo simulado → live.
//
// Flujo:
//   1. El dashboard setea betting_mode="live" Y pending_live_switch=true
//   2. El scheduler (cada 30 s) o en startup llama checkAndExecuteLiveSwitch()
//   3. Si el flag está activo:
//      a. Loguea la configuración completa activa
//      b. Busca el ciclo simulado abierto para mañana
//      c. Obtiene precios frescos de Polymarket (fallback al precio guardado)
//      d. Ejecuta órdenes reales via ClobClient
//      e. Actualiza trades/ciclo/predicción a simulated=false con orderIds reales
//      f. Loguea confirmación y limpia el flag
// ─────────────────────────────────────────────────────────────────────────────

import { format, addDays } from 'date-fns'
import { supabase }        from '../db/supabase'
import { BotEventLogger }  from './logger'
import { getStakeConfig, getConfigValue, setConfigValue } from './config'
import { getCurrentBias } from './bias-optimizer'
import { ClobClient }      from '../polymarket/clob'

const logger = new BotEventLogger('LIVE-SWITCH')

// ─── Entrypoint — llamado desde el scheduler ──────────────────────────────────

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

  // ── 2. Buscar ciclo simulado abierto para mañana ──────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .select('id, prediction_id, stake_usdc, multiplier')
    .eq('target_date', tomorrow)
    .eq('simulated', true)
    .eq('status', 'open')
    .maybeSingle()

  if (cycleErr) {
    await logger.error(`Error buscando ciclo pendiente: ${cycleErr.message}`, cycleErr)
    return
  }

  if (!cycle) {
    await logger.log(
      'warn', 'info',
      `⚠️  No hay ciclo simulado abierto para ${tomorrow}. ` +
      `El próximo ciclo (00:30) ya se ejecutará en modo real.`,
      { tomorrow }
    )
    return
  }

  await logger.log(
    'info', 'prediction',
    `📋 Ciclo simulado encontrado para ${tomorrow} (id: ${cycle.id}) — ejecutando órdenes reales...`
  )

  // ── 3. Buscar trades pendientes del ciclo ─────────────────────────────────
  const { data: trades, error: tradesErr } = await supabase
    .from('trades')
    .select('id, slug, token_temp, position, cost_usdc, price_at_buy, shares')
    .eq('prediction_id', cycle.prediction_id)
    .eq('simulated', true)
    .eq('status', 'open')

  if (tradesErr) {
    await logger.error(`Error leyendo trades: ${tradesErr.message}`, tradesErr)
    return
  }

  if (!trades || trades.length === 0) {
    await logger.log('warn', 'info', `⚠️  No se encontraron trades abiertos para el ciclo ${cycle.id}`)
    return
  }

  // ── 4. Obtener precios frescos de Polymarket ──────────────────────────────
  const freshPrices = await fetchFreshPrices(tomorrow)
  if (freshPrices) {
    await logger.log('info', 'info', `📈 Precios frescos obtenidos de Polymarket para ${tomorrow}`)
  } else {
    await logger.log('warn', 'info', `⚠️  No se pudieron obtener precios frescos — usando precios guardados en BD`)
  }

  // ── 5. Ejecutar órdenes reales via CLOB ───────────────────────────────────
  const clob = new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  )

  type TradeResult = {
    tradeId:   string
    tokenTemp: number
    position:  string
    orderId:   string | null
    priceUsed: number
    costUsdc:  number
    success:   boolean
    errorMsg?: string
  }

  const results: TradeResult[] = []

  for (const trade of trades) {
    // Precio fresco si está disponible, fallback al guardado en BD
    const freshPrice = freshPrices?.[trade.slug] ?? null
    const priceToUse = freshPrice ?? trade.price_at_buy

    let orderId: string | null = null
    let success = false
    let errorMsg: string | undefined

    try {
      const order = await clob.placeOrder({
        tokenId: trade.slug,
        side:    'BUY',
        price:   priceToUse,
        size:    trade.cost_usdc,
      })
      orderId = order.orderId
      success = true

      await logger.log(
        'success', 'prediction',
        `   ✅ Orden REAL ejecutada: ${trade.token_temp}°C (pos ${trade.position}) ` +
        `@ $${priceToUse.toFixed(4)} · $${trade.cost_usdc.toFixed(2)} USDC → orderId: ${orderId}`
      )
    } catch (err: any) {
      errorMsg = err?.message ?? String(err)
      await logger.error(
        `   ❌ Error ejecutando orden ${trade.token_temp}°C (${trade.position}): ${errorMsg}`,
        err
      )
    }

    results.push({ tradeId: trade.id, tokenTemp: trade.token_temp, position: trade.position,
                   orderId, priceUsed: priceToUse, costUsdc: trade.cost_usdc, success, errorMsg })

    // Actualizar trade en BD — precio fresco + orderId + simulated=false
    const { error: updateErr } = await supabase
      .from('trades')
      .update({
        simulated:           false,
        price_at_buy:        priceToUse,
        polymarket_order_id: orderId,
      })
      .eq('id', trade.id)

    if (updateErr) {
      await logger.error(`Error actualizando trade ${trade.id}: ${updateErr.message}`, updateErr)
    }
  }

  // ── 6. Actualizar ciclo y predicción a simulated=false ────────────────────
  const [{ error: cycleUpdateErr }, { error: predUpdateErr }] = await Promise.all([
    supabase.from('betting_cycles').update({ simulated: false }).eq('id', cycle.id),
    supabase.from('predictions').update({ simulated: false }).eq('id', cycle.prediction_id),
  ])

  if (cycleUpdateErr) await logger.error(`Error actualizando ciclo: ${cycleUpdateErr.message}`, cycleUpdateErr)
  if (predUpdateErr)  await logger.error(`Error actualizando predicción: ${predUpdateErr.message}`, predUpdateErr)

  // ── 7. Log resumen final ──────────────────────────────────────────────────
  const successCount = results.filter(r => r.success).length
  const failCount    = results.filter(r => !r.success).length
  const orderIds     = results.map(r => r.orderId ?? '(FAILED)').join(', ')
  const totalStake   = results.reduce((sum, r) => sum + r.costUsdc, 0)

  await logger.log(
    successCount === results.length ? 'success' : failCount === results.length ? 'error' : 'warn',
    'prediction',
    `🔴 TRANSICIÓN LIVE COMPLETADA — ${tomorrow}: ` +
    `${successCount}/${results.length} órdenes ejecutadas | ` +
    `stake total: $${totalStake.toFixed(2)} USDC | ` +
    `orderIds: [${orderIds}]` +
    (failCount > 0 ? ` | ⚠️ ${failCount} orden(es) fallaron — revisar logs` : ''),
    {
      targetDate:   tomorrow,
      cycleId:      cycle.id,
      predictionId: cycle.prediction_id,
      successCount,
      failCount,
      totalStake,
      orders:       results,
    }
  )
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
      `   stake:    $${stake.currentStake} (base $${stake.baseStake} ×${stake.multiplier})${capInfo}\n` +
      `   max:      $${stake.maxStake} | racha pérdidas: ${stake.consecutiveLosses}\n` +
      `   bias N:   ${signN}${biasN.toFixed(2)}°C\n` +
      `   pesos:    ${weightsSummary || '(sin fuentes activas)'}`,
      {
        targetDate,
        bettingMode:       'live',
        stake:             stake.currentStake,
        baseStake:         stake.baseStake,
        multiplier:        stake.multiplier,
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

// ─── Fetch precios frescos de Polymarket ─────────────────────────────────────
// Devuelve un mapa slug → priceYes, o null si falla

async function fetchFreshPrices(date: string): Promise<Record<string, number> | null> {
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
