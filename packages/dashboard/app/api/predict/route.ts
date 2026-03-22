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

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const {
      weights,        // pesos actualmente en los sliders
      optWeights,     // pesos óptimos calculados por MAE (pueden ser null)
      ensembleTemp,   // temperatura predicha (decimal)
      sourceTemps,    // { aemet: 32.1, open_meteo: 31.8, ... }
      targetDate,     // YYYY-MM-DD (mañana)
      stake = 20,     // stake total en USD
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

    // ── 1. Guardar pesos optimizados en weather_sources ───────────────────────
    //    Usamos optWeights si existen; si no, los pesos actuales del slider.
    const weightsToSave = optWeights ?? weights

    const weightUpdates = Object.entries(weightsToSave).map(([key, weight]) => {
      const dbSlug = SLUG_MAP[key] ?? key
      return supabase
        .from('weather_sources')
        .update({
          weight:     weight,
          updated_at: new Date().toISOString(),
        })
        .eq('slug', dbSlug)
    })
    await Promise.allSettled(weightUpdates)

    // ── 2. Calcular tokens (ceil y ceil+1) ────────────────────────────────────
    const ceilTemp  = Math.ceil(ensembleTemp)
    const tokenATemp = ceilTemp
    const tokenBTemp = ceilTemp + 1
    const tokenASlug = buildTokenSlug(targetDate, tokenATemp)
    const tokenBSlug = buildTokenSlug(targetDate, tokenBTemp)

    // ── 3. Precios actuales de Polymarket ─────────────────────────────────────
    const [priceA, priceB] = await Promise.all([
      getTokenPrice(tokenASlug),
      getTokenPrice(tokenBSlug),
    ])

    const costPerToken = parseFloat((stake / 2).toFixed(4))

    const sharesA = priceA && priceA > 0
      ? parseFloat((costPerToken / priceA).toFixed(4))
      : null
    const sharesB = priceB && priceB > 0
      ? parseFloat((costPerToken / priceB).toFixed(4))
      : null

    // ── 4. Upsert predicción ──────────────────────────────────────────────────
    //    Si ya existe una predicción comparison_source=true para targetDate,
    //    la actualizamos (re-calcula con los pesos más recientes).
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
      cost_a_usdc:       costPerToken,
      cost_b_usdc:       costPerToken,
      stake_usdc:        stake,
      comparison_source: true,
      simulated:         true,
      settled:           false,
      // Columnas legacy (null en modelo nuevo)
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

    // ── 5. Reemplazar trades (eliminar previos + insertar nuevos) ─────────────
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
    ]

    const { data: trades, error: tradesError } = await supabase
      .from('trades')
      .insert(tradesPayload)
      .select()

    if (tradesError) throw tradesError

    // ── 6. Respuesta completa ─────────────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      prediction,
      trades,
      tokenA: {
        temp:   tokenATemp,
        slug:   tokenASlug,
        price:  priceA,
        shares: sharesA,
        cost:   costPerToken,
      },
      tokenB: {
        temp:   tokenBTemp,
        slug:   tokenBSlug,
        price:  priceB,
        shares: sharesB,
        cost:   costPerToken,
      },
      weightsApplied: weightsToSave,
      isUpdate: !!existing?.id,
    })
  } catch (err: any) {
    console.error('[save-prediction] Error:', err)
    return NextResponse.json({ error: err.message ?? 'Error desconocido' }, { status: 500 })
  }
}
