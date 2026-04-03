// packages/bot/src/betting/retry-orders.ts
// Detecta el flag pending_order_retry y re-ejecuta las órdenes CLOB
// del ciclo abierto para mañana usando la predicción ya guardada en Supabase.
// No crea predicción ni ciclo nuevo — solo reintenta las órdenes de compra.

import { format, addDays }  from 'date-fns'
import { supabase }          from '../db/supabase'
import { BotEventLogger }    from './logger'
import { getConfigValue, setConfigValue } from './config'
import { buildPosition }     from '../prediction/position'
import { ClobClient }        from '../polymarket/clob'

const logger = new BotEventLogger('RETRY-ORDERS')

export async function checkAndRetryOrders(): Promise<void> {
  const pending = await getConfigValue<boolean>('pending_order_retry')
  if (!pending) return

  await logger.log('info', 'info', '🔁 Flag pending_order_retry detectado — reintentando órdenes CLOB…')

  try {
    await executeOrderRetry()
  } catch (err) {
    await logger.error('Error durante el retry de órdenes', err)
  } finally {
    await setConfigValue('pending_order_retry', false)
    await logger.log('info', 'info', '🏁 Flag pending_order_retry limpiado')
  }
}

async function executeOrderRetry(): Promise<void> {
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

  // ── 1. Buscar ciclo abierto para mañana ───────────────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .select('id, prediction_id, token_a_temp, token_b_temp, stake_usdc, simulated')
    .eq('target_date', tomorrow)
    .eq('status', 'open')
    .maybeSingle()

  if (cycleErr || !cycle) {
    await logger.error(`No hay ciclo abierto para ${tomorrow} — nada que reintentar`, cycleErr)
    return
  }

  if (cycle.simulated) {
    await logger.log('warn', 'info',
      `⚠️  El ciclo de ${tomorrow} es simulado — no se envían órdenes reales a Polymarket`
    )
    return
  }

  // ── 2. Obtener precios frescos de Polymarket para los tokens del ciclo ─────
  // Usamos el token_a_temp ya decidido (no recalculamos el ensemble)
  await logger.log('info', 'prediction',
    `🔁 Reintentando órdenes para ${tomorrow} — tokens: ${cycle.token_a_temp}°C / ${cycle.token_b_temp}°C | stake: $${cycle.stake_usdc}`
  )

  // buildPosition con el token_a como temperatura (ya fue ceil'd al crear el ciclo)
  // Le pasamos token_a_temp - 0.5 para que ceil() devuelva exactamente token_a
  const position = await buildPosition(cycle.token_a_temp - 0.5, tomorrow)

  const tokenA = position.tokenA.tempCelsius
  const tokenB = position.tokenB.tempCelsius

  // Verificar que los tokens coinciden con el ciclo original
  if (tokenA !== cycle.token_a_temp || tokenB !== cycle.token_b_temp) {
    await logger.log('warn', 'prediction',
      `⚠️  Tokens del mercado no coinciden con el ciclo: ` +
      `ciclo=${cycle.token_a_temp}°/${cycle.token_b_temp}° | mercado=${tokenA}°/${tokenB}° — ` +
      `se usarán los tokens del mercado actual`
    )
  }

  const priceA = position.tokenA.priceAtBuy
  const priceB = position.tokenB.priceAtBuy
  const priceSum = (priceA ?? 0) + (priceB ?? 0)

  if (priceSum === 0) {
    await logger.error(`Precios no disponibles para ${tomorrow} — mercado no activo aún`)
    return
  }

  const shares = cycle.stake_usdc / priceSum
  const costA  = shares * (priceA ?? 0)
  const costB  = shares * (priceB ?? 0)

  await logger.log('info', 'prediction',
    `Precios: ${priceA ? (priceA * 100).toFixed(1) : '?'}¢ / ${priceB ? (priceB * 100).toFixed(1) : '?'}¢ | ` +
    `Shares: ${shares.toFixed(4)} | Coste A: $${costA.toFixed(4)} | Coste B: $${costB.toFixed(4)}`
  )

  // ── 3. Ejecutar órdenes CLOB ──────────────────────────────────────────────
  const clob = new ClobClient(
    process.env.POLYMARKET_API_KEY!,
    process.env.POLYMARKET_PRIVATE_KEY!
  )

  const orderDefs = [
    { slot: 'a' as const, token: position.tokenA, tempCelsius: tokenA, cost: costA },
    { slot: 'b' as const, token: position.tokenB, tempCelsius: tokenB, cost: costB },
  ]

  let successCount = 0
  const orderIds: string[] = []

  for (const def of orderDefs) {
    const price = def.token.priceAtBuy
    if (!price) {
      await logger.log('warn', 'prediction', `   ⚠️  Token ${def.tempCelsius}°C (${def.slot}): precio no disponible`)
      continue
    }

    try {
      const order = await clob.placeOrder({
        tokenId: def.token.tokenId,
        side:    'BUY',
        price,
        size:    def.cost,
      })
      successCount++
      orderIds.push(order.orderId)

      // Actualizar polymarket_order_id en trades
      await supabase
        .from('trades')
        .update({ polymarket_order_id: order.orderId, status: 'open' })
        .eq('prediction_id', cycle.prediction_id)
        .eq('position', def.slot)

      await logger.log('success', 'prediction',
        `   ✅ Orden REAL ejecutada: ${def.tempCelsius}°C (${def.slot}) ` +
        `@ ${(price * 100).toFixed(1)}¢ · $${def.cost.toFixed(4)} USDC → orderId: ${order.orderId}`
      )
    } catch (err: any) {
      await logger.error(
        `   ❌ Error orden ${def.tempCelsius}°C (${def.slot}): ${err?.message ?? err}`,
        err
      )
    }
  }

  // ── 4. Log resumen ────────────────────────────────────────────────────────
  await logger.log(
    successCount === 2 ? 'success' : successCount === 0 ? 'error' : 'warn',
    'prediction',
    `🔁 RETRY ÓRDENES ${tomorrow}: ${successCount}/2 ejecutadas | ` +
    `tokens: ${tokenA}°/${tokenB}° | stake: $${cycle.stake_usdc} | ` +
    `orderIds: [${orderIds.join(', ') || 'ninguna'}]`,
    { cycleId: cycle.id, successCount, orderIds, tokenA, tokenB }
  )
}
