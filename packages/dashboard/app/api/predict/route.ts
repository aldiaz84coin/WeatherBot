// packages/dashboard/app/api/predict/route.ts
//
// POST /api/predict
//
// Genera una predicción para mañana desde la página de comparativa.
// Guarda la predicción y trades en Supabase.
//
// NOTA: Los pesos NO se escriben aquí — se gestionan exclusivamente
//       desde el AI Optimizer del dashboard.
//
// Body:
//   weights      Record<string, number>       pesos (para ensemble_config)
//   optWeights   Record<string, number>|null  pesos óptimos
//   ensembleTemp number                       temperatura predicha
//   sourceTemps  Record<string, number>       snapshot de cada fuente
//   targetDate   string                       YYYY-MM-DD (mañana)
//   stake        number                       stake total en USD (default 20)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const MONTHS = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
]

function buildTokenSlug(date: string, tempCelsius: number): string {
  const d     = new Date(date + 'T12:00:00')
  const month = MONTHS[d.getMonth()]
  const day   = d.getDate()
  const year  = d.getFullYear()
  return `highest-temperature-in-madrid-on-${month}-${day}-${year}-${tempCelsius}c`
}

async function getTokenPrice(slug: string): Promise<number | null> {
  try {
    const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const data = await res.json()
    const market = Array.isArray(data) ? data[0] : data
    if (!market) return null
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices
    const price = parseFloat(prices?.[0] ?? '0')
    return isNaN(price) || price === 0 ? null : price
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const {
      weights,
      optWeights,
      ensembleTemp,
      sourceTemps,
      targetDate,
      stake = 20,
    } = body as {
      weights:      Record<string, number>
      optWeights:   Record<string, number> | null
      ensembleTemp: number
      sourceTemps:  Record<string, number>
      targetDate:   string
      stake:        number
    }

    if (!weights || ensembleTemp == null || !targetDate) {
      return NextResponse.json(
        { error: 'Faltan campos: weights, ensembleTemp, targetDate' },
        { status: 400 }
      )
    }

    // ── 1. Calcular tokens ────────────────────────────────────────────────────
    const tokenATemp = Math.ceil(ensembleTemp)
    const tokenBTemp = tokenATemp + 1
    const tokenASlug = buildTokenSlug(targetDate, tokenATemp)
    const tokenBSlug = buildTokenSlug(targetDate, tokenBTemp)

    // ── 2. Precios actuales de Polymarket ─────────────────────────────────────
    const [priceA, priceB] = await Promise.all([
      getTokenPrice(tokenASlug),
      getTokenPrice(tokenBSlug),
    ])

    const costPerToken = parseFloat((stake / 2).toFixed(4))
    const sharesA = priceA && priceA > 0 ? parseFloat((costPerToken / priceA).toFixed(4)) : null
    const sharesB = priceB && priceB > 0 ? parseFloat((costPerToken / priceB).toFixed(4)) : null

    // ── 3. Upsert predicción ──────────────────────────────────────────────────
    // Los pesos se guardan en ensemble_config/opt_weights solo para auditoría,
    // NO se escriben en weather_sources (lo gestiona el AI Optimizer).
    const { data: existing } = await supabase
      .from('predictions')
      .select('id')
      .eq('target_date', targetDate)
      .eq('comparison_source', true)
      .maybeSingle()

    const predPayload = {
      target_date:       targetDate,
      predicted_at:      new Date().toISOString(),
      ensemble_temp:     ensembleTemp,
      source_temps:      sourceTemps ?? {},
      ensemble_config:   weights,
      opt_weights:       optWeights ?? null,
      token_a:           tokenATemp,
      token_b:           tokenBTemp,
      cost_a_usdc:       costPerToken,
      cost_b_usdc:       costPerToken,
      stake_usdc:        stake,
      comparison_source: true,
      simulated:         true,
      settled:           false,
      token_low:         null,
      token_mid:         null,
      token_high:        null,
      cost_low_usdc:     null,
      cost_mid_usdc:     null,
      cost_high_usdc:    null,
    }

    let prediction: any

    if (existing?.id) {
      const { data, error } = await supabase
        .from('predictions')
        .update(predPayload)
        .eq('id', existing.id)
        .select()
        .single()
      if (error) throw error
      prediction = data
    } else {
      const { data, error } = await supabase
        .from('predictions')
        .insert(predPayload)
        .select()
        .single()
      if (error) throw error
      prediction = data
    }

    // ── 4. Reemplazar trades ──────────────────────────────────────────────────
    await supabase.from('trades').delete().eq('prediction_id', prediction.id)

    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .insert([
        {
          prediction_id: prediction.id,
          slug:          tokenASlug,
          token_temp:    tokenATemp,
          position:      'a',
          cost_usdc:     costPerToken,
          price_at_buy:  priceA,
          shares:        sharesA,
          simulated:     true,
          status:        'open',
        },
        {
          prediction_id: prediction.id,
          slug:          tokenBSlug,
          token_temp:    tokenBTemp,
          position:      'b',
          cost_usdc:     costPerToken,
          price_at_buy:  priceB,
          shares:        sharesB,
          simulated:     true,
          status:        'open',
        },
      ])
      .select()

    if (tradesError) throw tradesError

    // ── 5. Respuesta ──────────────────────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      prediction,
      trades,
      tokenA: { temp: tokenATemp, slug: tokenASlug, price: priceA, shares: sharesA, cost: costPerToken },
      tokenB: { temp: tokenBTemp, slug: tokenBSlug, price: priceB, shares: sharesB, cost: costPerToken },
      weightsUsed: optWeights ?? weights,
      isUpdate: !!existing?.id,
    })
  } catch (err: any) {
    console.error('[predict] Error:', err)
    return NextResponse.json({ error: err.message ?? 'Error desconocido' }, { status: 500 })
  }
}
