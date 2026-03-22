// packages/dashboard/app/api/comparison/save-prediction/route.ts
//
// POST /api/comparison/save-prediction
//
// Flujo completo al pulsar "Registrar operación" desde la comparativa:
//   1. Persistir pesos optimizados (opt o actuales) en weather_sources
//   2. Upsert de la predicción para target_date con comparison_source=true
//   3. Obtener precios actuales de Polymarket para los dos slugs
//   4. Insertar 2 trades simulados (token_a y token_b)
//
// Body:
//   weights       Record<SourceKey, number>   pesos actualmente aplicados
//   optWeights    Record<SourceKey, number>|null  pesos óptimos (MAE inverso)
//   ensembleTemp  number                      temperatura predicha
//   sourceTemps   Record<string, number>      snapshot de cada fuente
//   targetDate    string                      YYYY-MM-DD (mañana)
//   stake         number                      stake total en USD (default 20)
//
// Lógica de reparto de stake:
//   Se compra el MISMO número de shares (N) para token_a y token_b.
//   N = stake / (priceA + priceB)
//   costA = N * priceA  |  costB = N * priceB
//   Si algún precio es desconocido → reparto 50/50 por coste.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Cliente Supabase (service key en server-side) ────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Mapa frontend-key → slug de la BD (weather_sources.slug)
const SLUG_MAP: Record<string, string> = {
  open_meteo:      'open-meteo',
  aemet:           'aemet',
  visual_crossing: 'visual-crossing',
  weatherapi:      'weatherapi',
  openweather:     'openweathermap',
  tomorrow:        'tomorrow-io',
  accuweather:     'accuweather',
}

// ─── Precio YES del token en Polymarket ──────────────────────────────────────

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

// ─── Reparto de stake por igual número de shares ──────────────────────────────
//
// Objetivo: comprar exactamente N shares de cada token, donde:
//   N = stake / (priceA + priceB)
//   costA = N * priceA  (proporción al precio)
//   costB = N * priceB
//
// Si algún precio es null → reparto 50/50 por coste (fallback).

interface StakeAllocation {
  shares:  number        // número de tokens comprados de cada posición
  costA:   number        // USD gastados en token A
  costB:   number        // USD gastados en token B
}

function allocateStake(
  stake:  number,
  priceA: number | null,
  priceB: number | null,
): StakeAllocation {
  if (priceA && priceA > 0 && priceB && priceB > 0) {
    // Mismo número de shares para ambos tokens
    const N     = parseFloat((stake / (priceA + priceB)).toFixed(4))
    const costA = parseFloat((N * priceA).toFixed(4))
    const costB = parseFloat((N * priceB).toFixed(4))
    return { shares: N, costA, costB }
  }
  // Fallback: reparto igualado por coste
  const half = parseFloat((stake / 2).toFixed(4))
  return {
    shares: priceA && priceA > 0 ? parseFloat((half / priceA).toFixed(4)) : 0,
    costA:  half,
    costB:  half,
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

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

    // ── 4. Persistir pesos en weather_sources ─────────────────────────────────
    const weightsToSave = optWeights ?? weights
    const weightUpdates = Object.entries(weightsToSave).map(([key, weight]) => {
      const slug = SLUG_MAP[key] ?? key
      return supabase
        .from('weather_sources')
        .update({ weight: weight as number, updated_at: new Date().toISOString() })
        .eq('slug', slug)
    })
    await Promise.allSettled(weightUpdates)

    // ── 5. Upsert predicción ──────────────────────────────────────────────────
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
      // Tokens (2-token model)
      token_a:           tokenATemp,
      token_b:           tokenBTemp,
      cost_a_usdc:       costA,
      cost_b_usdc:       costB,
      stake_usdc:        stake,
      comparison_source: true,
      simulated:         true,
      settled:           false,
      // Columnas legacy → null en modelo nuevo
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

    // ── 6. Reemplazar trades ──────────────────────────────────────────────────
    await supabase
      .from('trades')
      .delete()
      .eq('prediction_id', prediction.id)

    const tradesPayload = [
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
    ]

    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .insert(tradesPayload)
      .select()

    if (tradesError) throw tradesError

    // ── 7. Respuesta completa ─────────────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      prediction,
      trades,
      tokenA: {
        temp:   tokenATemp,
        slug:   tokenASlug,
        price:  priceA,
        shares: sharesA,
        cost:   costA,
      },
      tokenB: {
        temp:   tokenBTemp,
        slug:   tokenBSlug,
        price:  priceB,
        shares: sharesB,
        cost:   costB,
      },
      weightsApplied: weightsToSave,
      isUpdate: !!existing?.id,
    })
  } catch (err: any) {
    console.error('[save-prediction] Error:', err)
    return NextResponse.json({ error: err.message ?? 'Error desconocido' }, { status: 500 })
  }
}
