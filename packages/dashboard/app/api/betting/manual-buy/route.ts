// packages/dashboard/app/api/betting/manual-buy/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/betting/manual-buy?date=YYYY-MM-DD&stake=N
//   → Consulta precios Polymarket y calcula posición con config activa del bot.
//   → Devuelve configApplied (pesos + bias) para que el dashboard la muestre.
//
// POST /api/betting/manual-buy
//   body: { date, stake, execute: true }
//   → Ejecuta órdenes CLOB reales en Polymarket.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL         ?? process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Helpers de slug ──────────────────────────────────────────────────────────

function buildDaySlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `highest-temperature-in-madrid-on-${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}

// ─── Fetch Polymarket Gamma API ───────────────────────────────────────────────

async function fetchMarketData(date: string) {
  const slug     = buildDaySlug(date)
  const url      = `${GAMMA_BASE}/events?slug=${slug}`
  const debug: any = { slug, url }
  let httpStatus: number | null = null

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    httpStatus          = resp.status
    debug.httpStatus    = httpStatus
    const rawResponse   = await resp.json()
    debug.eventCount    = Array.isArray(rawResponse) ? rawResponse.length : null
    debug.eventKeys     = Array.isArray(rawResponse) && rawResponse.length > 0
      ? Object.keys(rawResponse[0])
      : []
    debug.marketCount   = Array.isArray(rawResponse) && rawResponse.length > 0
      ? (rawResponse[0].markets?.length ?? 0)
      : 0

    if (!Array.isArray(rawResponse) || rawResponse.length === 0) {
      debug.reason = 'Sin eventos en la respuesta — mercado no creado aún'
      return { available: false, tokens: [], debug }
    }

    const markets: any[] = rawResponse[0].markets ?? []
    debug.marketsRaw = markets.map((m: any) => ({
      slug:           m.slug,
      groupItemTitle: m.groupItemTitle,
      outcomePrices:  m.outcomePrices,
      clobTokenIds:   m.clobTokenIds,
      closed:         m.closed,
      resolvedPrice:  m.resolvedPrice,
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

  const priceA   = tokenA?.price ?? 0
  const priceB   = tokenB?.price ?? 0
  const priceSum = priceA + priceB

  let costA = 0
  let costB = 0
  let shares = 0

  if (priceSum > 0) {
    shares = stake / priceSum
    costA  = shares * priceA
    costB  = shares * priceB
  } else {
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

// ─── GET — consulta precios y calcula breakdown con config activa ─────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date     = searchParams.get('date')
  const stakeRaw = searchParams.get('stake')
  const stake    = stakeRaw ? parseFloat(stakeRaw) : 20

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Parámetro date requerido (YYYY-MM-DD)' }, { status: 400 })
  }
  if (isNaN(stake) || stake <= 0) {
    return NextResponse.json({ error: 'Stake debe ser un número positivo' }, { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // ── Fetch en paralelo: precios + config activa del bot ────────────────────
  const [
    marketData,
    { data: pred },
    { data: biasConfig },
    { data: sources },
  ] = await Promise.all([
    fetchMarketData(date),

    supabase
      .from('predictions')
      .select('id, ensemble_temp, ensemble_adjusted, bias_applied')
      .eq('target_date', date)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'prediction_bias_n')
      .maybeSingle(),

    supabase
      .from('weather_sources')
      .select('slug, name, weight')
      .eq('active', true)
      .order('weight', { ascending: false }),
  ])

  // ── Extraer bias y pesos actuales de la BD ────────────────────────────────
  const currentBiasN: number = biasConfig?.value != null ? Number(biasConfig.value) : 0
  const weights = (sources ?? []).map(s => ({
    slug:   s.slug   as string,
    name:   s.name   as string,
    weight: s.weight as number,
  }))

  // ── Determinar el ensemble con bias correcto ──────────────────────────────
  // Prioridad:
  //   1. ensemble_adjusted guardado en predictions (tiene bias ya incorporado)
  //   2. ensemble_temp + bias actual (si la predicción no tiene ensemble_adjusted)
  //   3. Fallback: media ponderada de tokens por precio (si no hay predicción)
  let ensembleRaw:      number | null = pred?.ensemble_temp     ?? null
  let biasApplied:      number        = currentBiasN
  let ensembleAdjusted: number | null = null
  let configSource: 'prediction_with_bias' | 'prediction_bias_recalculated' | 'fallback_no_prediction'

  if (pred?.ensemble_adjusted != null) {
    // Caso ideal: predicción guardada con ensemble_adjusted ya listo
    ensembleAdjusted = pred.ensemble_adjusted
    biasApplied      = pred.bias_applied ?? currentBiasN
    configSource     = 'prediction_with_bias'
  } else if (ensembleRaw != null) {
    // Predicción existe pero sin ensemble_adjusted → aplicar bias actual
    ensembleAdjusted = parseFloat((ensembleRaw + currentBiasN).toFixed(4))
    biasApplied      = currentBiasN
    configSource     = 'prediction_bias_recalculated'
  } else {
    // Sin predicción → usar media ponderada de precios de mercado como aproximación
    const sortedByPrice = [...marketData.tokens].sort((a, b) => b.price - a.price)
    const totalPriceSum = sortedByPrice.reduce((s, t) => s + t.price, 0)
    const weightedTemp  = totalPriceSum > 0
      ? sortedByPrice.reduce((s, t) => s + t.tempCelsius * t.price, 0) / totalPriceSum
      : (sortedByPrice[0]?.tempCelsius ?? 20)
    ensembleRaw      = parseFloat(weightedTemp.toFixed(4))
    ensembleAdjusted = parseFloat((weightedTemp + currentBiasN).toFixed(4))
    biasApplied      = currentBiasN
    configSource     = 'fallback_no_prediction'
  }

  // ── Calcular posición si hay tokens ──────────────────────────────────────
  let position = null
  if (marketData.available && marketData.tokens.length > 0 && ensembleAdjusted != null) {
    position = computePosition(marketData.tokens, ensembleAdjusted, stake)
  }

  // ── Objeto de configuración aplicada para mostrar en el dashboard ─────────
  const configApplied = {
    ensembleRaw:      ensembleRaw,
    biasN:            biasApplied,
    ensembleAdjusted: ensembleAdjusted,
    tokenA:           ensembleAdjusted != null ? Math.ceil(ensembleAdjusted)     : null,
    tokenB:           ensembleAdjusted != null ? Math.ceil(ensembleAdjusted) + 1 : null,
    weights:          weights,
    source:           configSource,
    predictionId:     pred?.id ?? null,
  }

  return NextResponse.json({
    date,
    stake,
    available:     marketData.available,
    tokens:        marketData.tokens,
    position,
    configApplied,
    debug:         marketData.debug,
    fetchedAt:     new Date().toISOString(),
  })
}

// ─── POST — ejecutar compra real ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: {
    date?:    string
    stake?:   number
    tempA?:   number
    tempB?:   number
    execute?: boolean
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

  // ── 2. Determinar ensemble con bias correcto ──────────────────────────────
  const [{ data: pred }, { data: biasConfig }] = await Promise.all([
    supabase
      .from('predictions')
      .select('id, ensemble_temp, ensemble_adjusted, bias_applied')
      .eq('target_date', date)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'prediction_bias_n')
      .maybeSingle(),
  ])

  const currentBiasN = biasConfig?.value != null ? Number(biasConfig.value) : 0

  let usedTemp: number
  if (pred?.ensemble_adjusted != null) {
    usedTemp = pred.ensemble_adjusted
  } else if (pred?.ensemble_temp != null) {
    usedTemp = parseFloat((pred.ensemble_temp + currentBiasN).toFixed(4))
  } else {
    const sortedByPrice = [...marketData.tokens].sort((a, b) => b.price - a.price)
    const totalPriceSum = sortedByPrice.reduce((s, t) => s + t.price, 0)
    usedTemp = totalPriceSum > 0
      ? parseFloat((sortedByPrice.reduce((s, t) => s + t.tempCelsius * t.price, 0) / totalPriceSum + currentBiasN).toFixed(4))
      : (sortedByPrice[0]?.tempCelsius ?? 20)
  }

  debugLog.push({
    step:            '2_ensemble',
    predictionId:    pred?.id ?? null,
    ensembleRaw:     pred?.ensemble_temp  ?? null,
    ensembleAdj:     pred?.ensemble_adjusted ?? null,
    biasApplied:     pred?.bias_applied   ?? currentBiasN,
    currentBiasN,
    usedTemp,
  })

  // ── 3. Calcular posición ──────────────────────────────────────────────────
  const position = computePosition(marketData.tokens, usedTemp, stake)

  debugLog.push({ step: '3_position', position })

  if (!position.tokenA.found || !position.tokenB.found) {
    return NextResponse.json({
      ok:    false,
      error: `Tokens no encontrados: ${position.tokenA.tempCelsius}°C=${position.tokenA.found}, ${position.tokenB.tempCelsius}°C=${position.tokenB.found}`,
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

  // ── 5. Ejecutar órdenes CLOB reales ──────────────────────────────────────
  // (la lógica CLOB real se delega al bot vía flag en bot_config)
  const { error: flagErr } = await supabase
    .from('bot_config')
    .upsert({
      key:        'pending_manual_buy',
      value:      { date, stake, tempA: position.tokenA.tempCelsius, tempB: position.tokenB.tempCelsius },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })

  debugLog.push({ step: '5_execute', flagErr: flagErr?.message ?? null })

  if (flagErr) {
    return NextResponse.json({
      ok:    false,
      error: `Error al registrar compra pendiente: ${flagErr.message}`,
      debug: debugLog,
    }, { status: 500 })
  }

  return NextResponse.json({
    ok:      true,
    preview: false,
    date,
    stake,
    position,
    message: 'Compra manual registrada — el bot ejecutará las órdenes CLOB en los próximos 30 s',
    debug:   debugLog,
  })
}
