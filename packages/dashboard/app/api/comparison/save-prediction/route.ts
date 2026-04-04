// packages/dashboard/app/api/comparison/save-prediction/route.ts
//
// POST /api/comparison/save-prediction
//
// Flujo al pulsar "Registrar operación" desde la comparativa:
//   1. Calcular tokens y precios de Polymarket
//   2. Upsert de la predicción para target_date con comparison_source=true
//   3. Insertar 2 trades simulados (token_a y token_b)
//
// NOTA: Los pesos NO se escriben aquí — se gestionan exclusivamente
//       desde el AI Optimizer del dashboard.
//
// Body:
//   weights       Record<SourceKey, number>   pesos actualmente aplicados (solo para guardar en ensemble_config)
//   optWeights    Record<SourceKey, number>|null  pesos óptimos (MAE inverso)
//   ensembleTemp  number                      temperatura predicha
//   sourceTemps   Record<string, number>      snapshot de cada fuente
//   targetDate    string                      YYYY-MM-DD (mañana)
//   stake         number                      stake total en USD (default 20)
//
// Reparto de stake:
//   N = stake / (priceA + priceB)
//   costA = N * priceA  |  costB = N * priceB
//   Si algún precio es desconocido → reparto 50/50 por coste.

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

interface StakeAllocation { shares: number; costA: number; costB: number }

function allocateStake(stake: number, priceA: number | null, priceB: number | null): StakeAllocation {
  if (priceA && priceA > 0 && priceB && priceB > 0) {
    const N     = parseFloat((stake / (priceA + priceB)).toFixed(4))
    const costA = parseFloat((N * priceA).toFixed(4))
    const costB = parseFloat((N * priceB).toFixed(4))
    return { shares: N, costA, costB }
  }
  const half = parseFloat((stake / 2).toFixed(4))
  return {
    shares: priceA && priceA > 0 ? parseFloat((half / priceA).toFixed(4)) : 0,
    costA:  half,
    costB:  half,
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
    } = body

    if (!weights || !ensembleTemp || !targetDate) {
      return NextResponse.json({ error: 'Faltan parámetros obligatorios' }, { status: 400 })
    }

    // ── 1. Calcular tokens ────────────────────────────────────────────────────
    const tokenATemp = Math.ceil(ensembleTemp)
    const tokenBTemp = tokenATemp + 1
    const tokenASlug = buildTokenSlug(targetDate, tokenATemp)
    const tokenBSlug = buildTokenSlug(targetDate, tokenBTemp)

    // ── 2. Precios Polymarket ─────────────────────────────────────────────────
    const [priceA, priceB] = await Promise.all([
      getTokenPrice(tokenASlug),
      getTokenPrice(tokenBSlug),
    ])

    // ── 3. Reparto de stake: mismo número de shares ───────────────────────────
    const { shares, costA, costB } = allocateStake(stake, priceA, priceB)
    const sharesA = priceA && priceA > 0 ? shares : null
    const sharesB = priceB && priceB > 0 ? shares : null

    // ── 4. Upsert predicción ──────────────────────────────────────────────────
    // Los pesos se guardan en ensemble_config/opt_weights solo para auditoría,
    // NO se escriben en weather_sources (eso lo gestiona el AI Optimizer).
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
      cost_a_usdc:       costA,
      cost_b_usdc:       costB,
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

    // ── 5. Reemplazar trades ──────────────────────────────────────────────────
    await supabase.from('trades').delete().eq('prediction_id', prediction.id)

    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .insert([
        {
          prediction_id: prediction.id,
          slug:          tokenASlug,
          token_temp:    tokenATemp,
          position:      'a',
          cost_usdc:     costA,
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
          cost_usdc:     costB,
          price_at_buy:  priceB,
          shares:        sharesB,
          simulated:     true,
          status:        'open',
        },
      ])
      .select()

    if (tradesError) throw tradesError

    // ── 6. Respuesta ──────────────────────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      prediction,
      trades,
      tokenA: { temp: tokenATemp, slug: tokenASlug, price: priceA, shares: sharesA, cost: costA },
      tokenB: { temp: tokenBTemp, slug: tokenBSlug, price: priceB, shares: sharesB, cost: costB },
      weightsUsed: optWeights ?? weights,
      isUpdate: !!existing?.id,
    })
  } catch (err: any) {
    console.error('[save-prediction] Error:', err)
    return NextResponse.json({ error: err.message ?? 'Error desconocido' }, { status: 500 })
  }
}
