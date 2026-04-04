// packages/bot/src/betting/manual-buy-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
// Detecta el flag pending_manual_buy en bot_config y ejecuta las órdenes CLOB
// reales en Polymarket para la compra manual solicitada desde el dashboard.
//
// El dashboard escribe en bot_config:
//   pending_manual_buy = { date, stake, tempA, tempB }
//
// Este handler lo lee, ejecuta las órdenes y limpia el flag.
// ─────────────────────────────────────────────────────────────────────────────

import { format, addDays }  from 'date-fns'
import { supabase }          from '../db/supabase'
import { BotEventLogger }    from './logger'
import { getConfigValue, setConfigValue } from './config'
import { GammaClient }       from '../polymarket/gamma'
import { ClobClient }        from '../polymarket/clob'

const logger = new BotEventLogger('MANUAL-BUY')

interface ManualBuyPayload {
  date:   string
  stake:  number
  tempA?: number
  tempB?: number
}

export async function checkAndExecuteManualBuy(): Promise<void> {
  const raw = await getConfigValue<unknown>('pending_manual_buy')

  // Si el flag no existe, es false, null, o no es un objeto con datos → salir
  if (!raw || typeof raw !== 'object') return

  const payload = raw as ManualBuyPayload

  if (!payload.date || !payload.stake) {
    await logger.log('warn', 'info', '⚠️  pending_manual_buy sin datos válidos — limpiando flag', { raw })
    await setConfigValue('pending_manual_buy', false)
    return
  }

  await logger.log('info', 'prediction',
    `🛒 Flag pending_manual_buy detectado — ejecutando compra manual para ${payload.date} · stake: $${payload.stake}`
  )

  try {
    await executeManualBuy(payload)
  } catch (err) {
    await logger.error('Error durante la compra manual', err)
  } finally {
    await setConfigValue('pending_manual_buy', false)
    await logger.log('info', 'info', '🏁 Flag pending_manual_buy limpiado')
  }
}

async function executeManualBuy(payload: ManualBuyPayload): Promise<void> {
  const { date, stake } = payload

  // ── 1. Obtener tokens frescos de Polymarket ───────────────────────────────
  const gamma     = new GammaClient()
  const dayTokens = await gamma.getTokensForDate(date)

  if (!dayTokens.available || dayTokens.tokens.length === 0) {
    await logger.error(`Mercado no disponible para ${date} — compra manual abortada`)
    return
  }

  // ── 2. Determinar qué temperaturas comprar ────────────────────────────────
  // Si vienen explícitas en el payload, usarlas; si no, calcular desde el bias
  let tempA = payload.tempA
  let tempB = payload.tempB

  if (!tempA || !tempB) {
    // Leer predicción o calcular desde bias+ensemble
    const { data: pred } = await supabase
      .from('predictions')
      .select('ensemble_adjusted, ensemble_temp, bias_applied')
      .eq('target_date', date)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: biasConfig } = await supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'prediction_bias_n')
      .maybeSingle()

    const biasN = biasConfig?.value != null ? Number(biasConfig.value) : 0

    let usedTemp: number
    if (pred?.ensemble_adjusted != null) {
      usedTemp = pred.ensemble_adjusted
    } else if (pred?.ensemble_temp != null) {
      usedTemp = pred.ensemble_temp + biasN
    } else {
      // Fallback: temperatura implícita del mercado (mayor precio)
      const top = [...dayTokens.tokens].sort((a, b) => b.price - a.price)[0]
      usedTemp = (top?.tempCelsius ?? 25) + biasN
      await logger.log('warn', 'info',
        `Sin predicción para ${date} — usando temperatura implícita del mercado: ${usedTemp.toFixed(2)}°C`
      )
    }

    tempA = Math.ceil(usedTemp)
    tempB = tempA + 1
  }

  await logger.log('info', 'prediction',
    `Tokens objetivo: ${tempA}°C / ${tempB}°C`
  )

  // ── 3. Buscar los tokens en el mercado ────────────────────────────────────
  const matchA = dayTokens.tokens.find(t => t.tempCelsius === tempA)
  const matchB = dayTokens.tokens.find(t => t.tempCelsius === tempB)

  if (!matchA || !matchB) {
    await logger.error(
      `Tokens no encontrados en el mercado: ${tempA}°C=${!!matchA}, ${tempB}°C=${!!matchB}`,
      { available: dayTokens.tokens.map(t => t.tempCelsius) }
    )
    return
  }

  const priceA   = matchA.price
  const priceB   = matchB.price
  const priceSum = priceA + priceB

  if (priceSum <= 0) {
    await logger.error(`Precios inválidos: A=${priceA}, B=${priceB}`)
    return
  }

  // ── 4. Calcular shares y costes ────────────────────────────────────────────
  const shares = stake / priceSum
  const costA  = parseFloat((shares * priceA).toFixed(4))
  const costB  = parseFloat((shares * priceB).toFixed(4))

  await logger.log('info', 'prediction',
    `Precios: ${(priceA * 100).toFixed(1)}¢ / ${(priceB * 100).toFixed(1)}¢ | ` +
    `Shares: ${shares.toFixed(4)} | Coste A: $${costA} | Coste B: $${costB}`
  )

  // ── 5. Verificar que LIVE_TRADING está activo ─────────────────────────────
  const { data: modeConfig } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', 'betting_mode')
    .maybeSingle()

  const bettingMode = typeof modeConfig?.value === 'string'
    ? modeConfig.value.replace(/"/g, '')
    : String(modeConfig?.value ?? '')

  if (bettingMode !== 'live' && process.env.LIVE_TRADING !== 'true') {
    await logger.log('warn', 'info',
      `⚠️  Modo ${bettingMode} — compra manual registrada como SIMULACIÓN (no se envían órdenes reales)`
    )
    await recordSimulatedManualBuy(date, tempA, tempB, priceA, priceB, costA, costB, shares)
    return
  }

  // ── 6. Ejecutar órdenes CLOB reales ───────────────────────────────────────
  const clob = new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  )

  const orderDefs = [
    { slot: 'a' as const, match: matchA, temp: tempA, cost: costA },
    { slot: 'b' as const, match: matchB, temp: tempB, cost: costB },
  ]

  let successCount = 0
  const orderIds: string[] = []

  for (const def of orderDefs) {
    try {
      const order = await clob.placeOrder({
        tokenId: def.match.tokenId,
        side:    'BUY',
        price:   def.match.price,
        size:    def.cost,
      })
      successCount++
      orderIds.push(order.orderId)

      await logger.log('success', 'prediction',
        `   ✅ Orden REAL ejecutada (manual): ${def.temp}°C @ ${(def.match.price * 100).toFixed(1)}¢ · $${def.cost} USDC → orderId: ${order.orderId}`
      )
    } catch (err: any) {
      await logger.error(
        `   ❌ Error orden manual ${def.temp}°C (${def.slot}): ${err?.message ?? err}`,
        err
      )
    }
  }

  // ── 7. Log resumen ────────────────────────────────────────────────────────
  await logger.log(
    successCount === 2 ? 'success' : successCount === 0 ? 'error' : 'warn',
    'prediction',
    `🛒 COMPRA MANUAL ${date}: ${successCount}/2 órdenes ejecutadas | ` +
    `tokens: ${tempA}°/${tempB}° | stake: $${stake} | ` +
    `orderIds: [${orderIds.join(', ') || 'ninguna'}]`,
    { date, tempA, tempB, stake, shares: parseFloat(shares.toFixed(4)), successCount, orderIds }
  )
}

// ─── Registrar compra simulada (modo no-live) ─────────────────────────────────

async function recordSimulatedManualBuy(
  date:   string,
  tempA:  number,
  tempB:  number,
  priceA: number,
  priceB: number,
  costA:  number,
  costB:  number,
  shares: number,
): Promise<void> {
  await logger.log('info', 'prediction',
    `🟡 Compra manual SIMULADA registrada — ${date}: ${tempA}°C ($${costA}) / ${tempB}°C ($${costB})`,
    { date, tempA, tempB, priceA, priceB, costA, costB, shares: parseFloat(shares.toFixed(4)), simulated: true }
  )
}
