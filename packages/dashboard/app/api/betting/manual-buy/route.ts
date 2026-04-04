// packages/dashboard/app/api/betting/manual-buy/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Compra manual adicional fuera del ciclo automático del bot.
//
// GET  /api/betting/manual-buy?date=2026-04-06&stake=20
//   → Consulta precios frescos de Polymarket para la fecha dada.
//   → Calcula breakdown de tokens y costes.
//   → Devuelve información completa de debug (raw API response).
//
// POST /api/betting/manual-buy
//   body: { date, stake, execute: true }
//   → Ejecuta CLOB orders reales en Polymarket.
//   → Crea un betting_cycle y 2 trades en Supabase (marcados como manual).
//   → Devuelve resultado completo incluyendo order IDs y respuestas raw.
//
// Nota: Esta operación NO afecta al ciclo automático del bot ni a la
// lógica Martingala. Es una compra puntual de diagnóstico/trading.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const CLOB_BASE  = 'https://clob.polymarket.com'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ''

const MONTHS = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
]

function buildDaySlug(date: string): string {
  const d     = new Date(date + 'T12:00:00')
  const month = MONTHS[d.getMonth()]
  const day   = d.getDate()
  const year  = d.getFullYear()
  return `highest-temperature-in-madrid-on-${month}-${day}-${year}`
}

// ─── Fetch precios desde Polymarket con debug completo ────────────────────────

async function fetchMarketData(date: string) {
  const slug = buildDaySlug(date)
  const url  = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`

  const debug: Record<string, any> = { slug, url }

  let rawResponse: any = null
  let httpStatus: number | null = null

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    httpStatus = res.status
    debug.httpStatus = res.status

    if (!res.ok) {
      debug.error = `HTTP ${res.status}`
      return { available: false, tokens: [], debug }
    }

    rawResponse = await res.json()
    debug.rawResponseSummary = {
      isArray:    Array.isArray(rawResponse),
      eventCount: Array.isArray(rawResponse) ? rawResponse.length : null,
      eventKeys:  Array.isArray(rawResponse) && rawResponse.length > 0
        ? Object.keys(rawResponse[0])
        : [],
      marketCount: Array.isArray(rawResponse) && rawResponse.length > 0
        ? (rawResponse[0].markets?.length ?? 0)
        : 0,
    }

    if (!Array.isArray(rawResponse) || rawResponse.length === 0) {
      debug.reason = 'Sin eventos en la respuesta — mercado no creado aún'
      return { available: false, tokens: [], debug }
    }

    const markets: any[] = rawResponse[0].markets ?? []
    debug.marketsRaw = markets.map((m: any) => ({
      slug:            m.slug,
      groupItemTitle:  m.groupItemTitle,
      outcomePrices:   m.outcomePrices,
      clobTokenIds:    m.clobTokenIds,
      closed:          m.closed,
      resolvedPrice:   m.resolvedPrice,
    }))

    const tokens: {
      tempCelsius: number
      label:       string
      price:       number
      tokenId:     string
      slug:        string
      resolved:    boolean
      resolvedYes: boolean
    }[] = []

    for (const m of markets) {
      let tempCelsius: number | null = null
      const label: string = m.groupItemTitle ?? ''

      const titleMatch = label.match(/^(\d+)/)
      if (titleMatch) tempCelsius = parseInt(titleMatch[1])

      if (tempCelsius === null) {
        const slugMatch = (m.slug ?? '').match(/-(\d+)c(?:orbelow|orhigher)?$/)
        if (slugMatch) tempCelsius = parseInt(slugMatch[1])
      }

      if (tempCelsius === null) continue

      let price = 0
      try {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (m.outcomePrices ?? [])
        price = parseFloat(prices?.[0] ?? '0')
        if (isNaN(price)) price = 0
      } catch { price = 0 }

      let tokenId = ''
      try {
        const ids = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : (m.clobTokenIds ?? [])
        tokenId = ids?.[0] ?? ''
      } catch { tokenId = '' }

      const resolvedPrice = m.resolvedPrice
      const resolvedYes   = m.closed && (resolvedPrice === '1' || resolvedPrice === 1 || price >= 0.99)
      const resolved      = m.closed && resolvedPrice != null

      tokens.push({
        tempCelsius,
        label:      label || `${tempCelsius}°C`,
        price,
        tokenId,
        slug:       m.slug ?? '',
        resolved,
        resolvedYes,
      })
    }

    tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)
    debug.parsedTokenCount = tokens.length

    return { available: tokens.length > 0, tokens, debug }

  } catch (err: any) {
    debug.fetchError = err.message ?? String(err)
    debug.httpStatus = httpStatus
    return { available: false, tokens: [], debug }
  }
}

// ─── Calcular posición de 2 tokens (igual que el bot) ────────────────────────

function computePosition(
  tokens: { tempCelsius: number; price: number; tokenId: string; label: string; slug: string }[],
  ensembleTemp: number,
  stake: number
) {
  const ceilTemp = Math.ceil(ensembleTemp)
  const tempA    = ceilTemp
  const tempB    = ceilTemp + 1

  const tokenA = tokens.find(t => t.tempCelsius === tempA)
  const tokenB = tokens.find(t => t.tempCelsius === tempB)

  const priceA = tokenA?.price ?? 0
  const priceB = tokenB?.price ?? 0
  const priceSum = priceA + priceB

  let costA = 0
  let costB = 0
  let shares = 0

  if (priceSum > 0) {
    shares = stake / priceSum
    costA  = shares * priceA
    costB  = shares * priceB
  } else {
    // Sin precios → reparto 50/50
    costA = stake / 2
    costB = stake / 2
  }

  return {
    tokenA: {
      tempCelsius: tempA,
      label:       tokenA?.label ?? `${tempA}°C`,
      tokenId:     tokenA?.tokenId ?? '',
      slug:        tokenA?.slug ?? '',
      price:       priceA,
      cost:        parseFloat(costA.toFixed(4)),
      shares:      priceA > 0 ? parseFloat((costA / priceA).toFixed(4)) : null,
      found:       !!tokenA,
    },
    tokenB: {
      tempCelsius: tempB,
      label:       tokenB?.label ?? `${tempB}°C`,
      tokenId:     tokenB?.tokenId ?? '',
      slug:        tokenB?.slug ?? '',
      price:       priceB,
      cost:        parseFloat(costB.toFixed(4)),
      shares:      priceB > 0 ? parseFloat((costB / priceB).toFixed(4)) : null,
      found:       !!tokenB,
    },
    shares:    parseFloat(shares.toFixed(4)),
    priceSum:  parseFloat(priceSum.toFixed(4)),
    stake,
    ensembleTemp,
  }
}

// ─── GET — consulta precios y calcula breakdown ───────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date    = searchParams.get('date')
  const stakeRaw = searchParams.get('stake')
  const stake    = stakeRaw ? parseFloat(stakeRaw) : 20

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Parámetro date requerido (YYYY-MM-DD)' }, { status: 400 })
  }

  if (isNaN(stake) || stake <= 0) {
    return NextResponse.json({ error: 'Stake debe ser un número positivo' }, { status: 400 })
  }

  // ── Fetch precios ──────────────────────────────────────────────────────────
  const marketData = await fetchMarketData(date)

  // ── Si hay tokens, calcular posición ──────────────────────────────────────
  let position = null
  if (marketData.available && marketData.tokens.length > 0) {
    // Buscar ensemble de la predicción más reciente para esa fecha
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: pred } = await supabase
      .from('predictions')
      .select('ensemble_temp, ensemble_adjusted')
      .eq('target_date', date)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const ensembleTemp = pred?.ensemble_adjusted ?? pred?.ensemble_temp ?? null

    if (ensembleTemp != null) {
      position = computePosition(marketData.tokens, ensembleTemp, stake)
    } else {
      // Si no hay predicción, usar el token con mayor precio como referencia
      const sorted = [...marketData.tokens].sort((a, b) => b.price - a.price)
      const topTemp = sorted[0]?.tempCelsius ?? 20
      position = computePosition(marketData.tokens, topTemp - 0.5, stake)
    }
  }

  return NextResponse.json({
    date,
    stake,
    available:  marketData.available,
    tokens:     marketData.tokens,
    position,
    debug:      marketData.debug,
    fetchedAt:  new Date().toISOString(),
  })
}

// ─── POST — ejecutar compra real ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: {
    date?:     string
    stake?:    number
    tempA?:    number
    tempB?:    number
    execute?:  boolean
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
  }

  const { date, stake, execute = false } = body

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date requerida (YYYY-MM-DD)' }, { status: 400 })
  }

  if (!stake || stake <= 0) {
    return NextResponse.json({ error: 'stake debe ser un número positivo' }, { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // ── 1. Fetch precios frescos de Polymarket ────────────────────────────────
  const marketData = await fetchMarketData(date)
  const debugLog: any[] = []

  debugLog.push({
    step:      '1_fetch_market',
    available: marketData.available,
    tokens:    marketData.tokens.length,
    debug:     marketData.debug,
  })

  if (!marketData.available || marketData.tokens.length === 0) {
    return NextResponse.json({
      ok:    false,
      error: 'Mercado no disponible — no hay tokens de temperatura activos para esta fecha',
      debug: debugLog,
    }, { status: 422 })
  }

  // ── 2. Determinar ensemble desde la última predicción ─────────────────────
  const { data: pred } = await supabase
    .from('predictions')
    .select('id, ensemble_temp, ensemble_adjusted, bias_applied')
    .eq('target_date', date)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const ensembleTemp = pred?.ensemble_adjusted ?? pred?.ensemble_temp ?? null
  const usedTemp     = ensembleTemp != null
    ? ensembleTemp
    : (marketData.tokens.sort((a, b) => b.price - a.price)[0]?.tempCelsius ?? 20) - 0.5

  debugLog.push({
    step:         '2_ensemble',
    predictionId: pred?.id ?? null,
    ensembleTemp,
    biasApplied:  pred?.bias_applied ?? null,
    usedTemp,
  })

  // ── 3. Calcular posición ──────────────────────────────────────────────────
  const position = computePosition(marketData.tokens, usedTemp, stake)

  debugLog.push({ step: '3_position', position })

  if (!position.tokenA.found || !position.tokenB.found) {
    return NextResponse.json({
      ok:    false,
      error: `Tokens no encontrados en el mercado: ${position.tokenA.tempCelsius}°C=${position.tokenA.found}, ${position.tokenB.tempCelsius}°C=${position.tokenB.found}`,
      position,
      debug: debugLog,
    }, { status: 422 })
  }

  // ── 4. Si no es execute real, devolver solo preview ───────────────────────
  if (!execute) {
    return NextResponse.json({
      ok:       true,
      preview:  true,
      date,
      stake,
      position,
      debug:    debugLog,
    })
  }

  // ── 5. Verificar credenciales CLOB ───────────────────────────────────────
  const POLY_API_KEY  = process.env.POLYMARKET_API_KEY
  const POLY_PRIV_KEY = process.env.POLYMARKET_PRIVATE_KEY

  if (!POLY_API_KEY || !POLY_PRIV_KEY) {
    return NextResponse.json({
      ok:    false,
      error: 'Credenciales CLOB no configuradas (POLYMARKET_API_KEY / POLYMARKET_PRIVATE_KEY)',
      debug: debugLog,
    }, { status: 500 })
  }

  // ── 6. Crear betting_cycle manual en Supabase ─────────────────────────────
  const { data: cycle, error: cycleErr } = await supabase
    .from('betting_cycles')
    .insert({
      target_date:   date,
      stake_usdc:    stake,
      multiplier:    1,
      simulated:     false,
      status:        'open',
      token_a_temp:  position.tokenA.tempCelsius,
      token_b_temp:  position.tokenB.tempCelsius,
      cost_a_usdc:   position.tokenA.cost,
      cost_b_usdc:   position.tokenB.cost,
      shares:        position.shares,
      prediction_id: pred?.id ?? null,
      notes:         'manual_buy_dashboard',
    })
    .select('id')
    .single()

  debugLog.push({
    step:     '6_create_cycle',
    cycleId:  cycle?.id ?? null,
    error:    cycleErr?.message ?? null,
  })

  if (cycleErr || !cycle) {
    return NextResponse.json({
      ok:    false,
      error: `Error creando ciclo en DB: ${cycleErr?.message ?? 'sin id'}`,
      debug: debugLog,
    }, { status: 500 })
  }

  // ── 7. Ejecutar órdenes CLOB ──────────────────────────────────────────────
  const headers = {
    'Content-Type': 'application/json',
    'POLY_ADDRESS':  POLY_API_KEY,
  }

  type OrderResult = {
    slot:     'a' | 'b'
    temp:     number
    tokenId:  string
    price:    number
    size:     number
    success:  boolean
    orderId:  string | null
    status:   string | null
    rawReq:   any
    rawRes:   any
    error:    string | null
  }

  const orderDefs = [
    { slot: 'a' as const, temp: position.tokenA.tempCelsius, tokenId: position.tokenA.tokenId, price: position.tokenA.price, size: position.tokenA.cost },
    { slot: 'b' as const, temp: position.tokenB.tempCelsius, tokenId: position.tokenB.tokenId, price: position.tokenB.price, size: position.tokenB.cost },
  ]

  const orderResults: OrderResult[] = []

  for (const def of orderDefs) {
    const rawReq = {
      tokenID:   def.tokenId,
      side:      'BUY',
      price:     def.price,
      size:      def.size,
      orderType: 'LIMIT',
    }

    let rawRes: any = null
    let orderId: string | null = null
    let orderStatus: string | null = null
    let success = false
    let errorMsg: string | null = null

    try {
      const clobRes = await fetch(`${CLOB_BASE}/order`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(rawReq),
        signal:  AbortSignal.timeout(15_000),
      })

      rawRes = await clobRes.json()

      if (clobRes.ok) {
        orderId     = rawRes.orderID ?? rawRes.orderId ?? null
        orderStatus = rawRes.status ?? null
        success     = true
      } else {
        errorMsg = `HTTP ${clobRes.status}: ${JSON.stringify(rawRes)}`
      }
    } catch (err: any) {
      errorMsg = err.message ?? String(err)
      rawRes   = { fetchError: errorMsg }
    }

    orderResults.push({
      slot:    def.slot,
      temp:    def.temp,
      tokenId: def.tokenId,
      price:   def.price,
      size:    def.size,
      success,
      orderId,
      status:  orderStatus,
      rawReq,
      rawRes,
      error:   errorMsg,
    })

    debugLog.push({
      step:    `7_clob_${def.slot}`,
      temp:    def.temp,
      tokenId: def.tokenId,
      price:   def.price,
      size:    def.size,
      success,
      orderId,
      rawRes,
      error:   errorMsg,
    })
  }

  // ── 8. Persistir trades en Supabase ──────────────────────────────────────
  for (const r of orderResults) {
    const { error: tradeErr } = await supabase.from('trades').insert({
      prediction_id:       pred?.id ?? null,
      slug:                r.slot === 'a' ? position.tokenA.slug : position.tokenB.slug,
      token_temp:          r.temp,
      position:            r.slot,
      cost_usdc:           r.size,
      price_at_buy:        r.price,
      shares:              r.price > 0 ? parseFloat((r.size / r.price).toFixed(4)) : null,
      simulated:           false,
      polymarket_order_id: r.orderId,
      status:              r.success ? 'open' : 'error',
    })

    debugLog.push({
      step:     `8_trade_${r.slot}`,
      inserted: !tradeErr,
      error:    tradeErr?.message ?? null,
    })
  }

  // ── 9. Actualizar ciclo con order IDs ─────────────────────────────────────
  const resA = orderResults.find(r => r.slot === 'a')!
  const resB = orderResults.find(r => r.slot === 'b')!

  await supabase.from('betting_cycles').update({
    notes: `manual_buy_dashboard | ordA=${resA.orderId ?? 'err'} | ordB=${resB.orderId ?? 'err'}`,
  }).eq('id', cycle.id)

  // ── 10. Log en bot_events ─────────────────────────────────────────────────
  const successCount = orderResults.filter(r => r.success).length
  await supabase.from('bot_events').insert({
    severity:   successCount === 2 ? 'success' : successCount === 0 ? 'error' : 'warn',
    event_type: 'prediction',
    message:    `🛒 [MANUAL] Compra manual ${date}: ${successCount}/2 órdenes ejecutadas | ` +
                `tokens: ${resA.temp}°/${resB.temp}° | stake: $${stake} USDC | ` +
                `ordA: ${resA.orderId ?? 'err'} | ordB: ${resB.orderId ?? 'err'}`,
    payload:    { date, stake, successCount, orderResults: orderResults.map(r => ({
      slot: r.slot, temp: r.temp, orderId: r.orderId, status: r.status, success: r.success, error: r.error,
    })), source: 'dashboard_manual_buy' },
    cycle_id:   cycle.id,
  })

  // ── 11. Respuesta ────────────────────────────────────────────────────────
  return NextResponse.json({
    ok:           true,
    preview:      false,
    date,
    stake,
    cycleId:      cycle.id,
    position,
    orders:       orderResults.map(r => ({
      slot:     r.slot,
      temp:     r.temp,
      tokenId:  r.tokenId,
      price:    r.price,
      cost:     r.size,
      success:  r.success,
      orderId:  r.orderId,
      status:   r.status,
      error:    r.error,
    })),
    successCount,
    debug:        debugLog,
  })
}
