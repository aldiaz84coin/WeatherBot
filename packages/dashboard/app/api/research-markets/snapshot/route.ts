// packages/dashboard/app/api/research-markets/snapshot/route.ts
//
// POST /api/research-markets/snapshot
//
// Captura las predicciones de mañana para las 4 ciudades y las persiste
// en research_predictions. Lectura de pesos/bias de Madrid es READ-ONLY.
//
// Este endpoint NO escribe en ninguna tabla del bot real.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  CITIES, RESEARCH_SOURCES, type CityKey, type ResearchSource,
  cityTomorrow,
  fetchOpenMeteoForecast, fetchVisualCrossing, fetchWeatherApi,
  fetchOpenWeather, fetchTomorrow, fetchPolymarket,
  computeWeighted,
} from '@/lib/research/cities'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Mapping slug BD → key del snapshot (lo mismo que en la página)
const SLUG_TO_KEY: Record<string, ResearchSource> = {
  'open-meteo':       'open_meteo',
  'visual-crossing':  'visual_crossing',
  'weatherapi':       'weatherapi',
  'openweathermap':   'openweather',
  'tomorrow-io':      'tomorrow',
}

export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // ── 1. Leer pesos actuales (READ-ONLY) ─────────────────────────────────────
  const { data: sources, error: srcErr } = await supabase
    .from('weather_sources')
    .select('slug, weight, active')
    .eq('active', true)

  if (srcErr) return NextResponse.json({ error: `weather_sources: ${srcErr.message}` }, { status: 500 })

  // Extraer solo las 5 fuentes disponibles fuera de Madrid
  const rawWeights: Partial<Record<ResearchSource, number>> = {}
  for (const s of sources ?? []) {
    const key = SLUG_TO_KEY[s.slug]
    if (key) rawWeights[key] = s.weight
  }
  // Renormalizar (sin AEMET ni AccuWeather)
  const sumW = Object.values(rawWeights).reduce<number>((a, b) => a + (b ?? 0), 0)
  const weights: Record<ResearchSource, number> = {
    open_meteo: 0, visual_crossing: 0, weatherapi: 0, openweather: 0, tomorrow: 0,
  }
  if (sumW > 0) {
    for (const k of RESEARCH_SOURCES) {
      weights[k] = Math.round(((rawWeights[k] ?? 0) / sumW) * 10000) / 10000
    }
  } else {
    // Fallback equiponderado
    for (const k of RESEARCH_SOURCES) weights[k] = 0.2
  }

  // ── 2. Leer bias_n (READ-ONLY) ─────────────────────────────────────────────
  const { data: cfg } = await supabase
    .from('bot_config')
    .select('bias_n')
    .limit(1)
    .maybeSingle()
  const biasN: number = cfg?.bias_n ?? 0

  // ── 3. Fetch API keys ──────────────────────────────────────────────────────
  const keys = {
    visual_crossing: process.env.VISUAL_CROSSING_KEY ?? '',
    weatherapi:      process.env.WEATHERAPI_KEY      ?? '',
    openweather:     process.env.OPENWEATHER_API_KEY ?? '',
    tomorrow:        process.env.TOMORROW_IO_KEY     ?? '',
  }

  // ── 4. Para cada ciudad, fetch + compute + upsert ──────────────────────────
  const results: Array<{
    city: CityKey; target_date: string; ensemble: number | null;
    token_a: number | null; status: 'ok' | 'partial' | 'error'; error?: string
  }> = []

  for (const cityKey of Object.keys(CITIES) as CityKey[]) {
    const city = CITIES[cityKey]
    const target = cityTomorrow(city.tz)

    try {
      const [om, vc, wap, owm, tmr] = await Promise.all([
        fetchOpenMeteoForecast(city, target),
        fetchVisualCrossing(city, target, keys.visual_crossing),
        fetchWeatherApi(city, target, keys.weatherapi),
        fetchOpenWeather(city, target, keys.openweather),
        fetchTomorrow(city, target, keys.tomorrow),
      ])

      const sourceResults = {
        open_meteo: om, visual_crossing: vc, weatherapi: wap, openweather: owm, tomorrow: tmr,
      }
      const sourceTemps: Record<string, number> = {}
      for (const s of RESEARCH_SOURCES) {
        const v = sourceResults[s]?.tmax
        if (v != null) sourceTemps[s] = v
      }

      const ensemble = computeWeighted(sourceResults, weights)
      const tokenA = ensemble != null ? Math.ceil(ensemble + biasN) : null
      const tokenB = tokenA != null ? tokenA + 1 : null

      // Polymarket (best-effort, no bloquea)
      const poly = await fetchPolymarket(city.slug, target).catch(() => null)

      const status: 'ok' | 'partial' = Object.keys(sourceTemps).length >= 3 ? 'ok' : 'partial'

      const { error: upsertErr } = await supabase
        .from('research_predictions')
        .upsert({
          city: cityKey,
          target_date: target,
          forecast_fetched_at: new Date().toISOString(),
          source_temps: sourceTemps,
          weights_used: weights,
          bias_n_used: biasN,
          ensemble_temp: ensemble,
          token_a: tokenA,
          token_b: tokenB,
          polymarket_temp: poly?.temp ?? null,
          polymarket_price: poly?.price ?? null,
          polymarket_resolved: poly?.resolved ?? false,
          settled: false,
        }, { onConflict: 'city,target_date' })

      if (upsertErr) {
        results.push({ city: cityKey, target_date: target, ensemble, token_a: tokenA, status: 'error', error: upsertErr.message })
      } else {
        results.push({ city: cityKey, target_date: target, ensemble, token_a: tokenA, status })
      }
    } catch (e: any) {
      results.push({ city: cityKey, target_date: target, ensemble: null, token_a: null, status: 'error', error: e.message })
    }
  }

  return NextResponse.json({
    ok: true,
    snapshotted_at: new Date().toISOString(),
    weights_used: weights,
    bias_n_used: biasN,
    results,
  })
}

export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: '/api/research-markets/snapshot' })
}
