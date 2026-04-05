// packages/dashboard/app/api/research-markets/route.ts
//
// POST /api/research-markets
// Body: { city: 'london'|'milan'|'munich'|'moscow' }
//
// Fetch EN VIVO sin escribir nada en BD. Usado por la UI para exploración
// interactiva. La persistencia va por /snapshot y /settle.

import { NextRequest, NextResponse } from 'next/server'
import {
  CITIES, type CityKey,
  cityTomorrow, lastNDates,
  fetchOpenMeteoArchive, fetchOpenMeteoForecast, fetchOpenMeteo,
  fetchVisualCrossing, fetchWeatherApi, fetchOpenWeather, fetchTomorrow,
  fetchPolymarket,
} from '@/lib/research/cities'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const cityKey = body.city as CityKey
    const keyOverrides: Record<string, string> = body.keyOverrides ?? {}

    if (!cityKey || !(cityKey in CITIES)) {
      return NextResponse.json({ error: 'Ciudad inválida' }, { status: 400 })
    }
    const city = CITIES[cityKey]

    const keys = {
      visual_crossing: keyOverrides.visual_crossing ?? process.env.VISUAL_CROSSING_KEY ?? '',
      weatherapi:      keyOverrides.weatherapi      ?? process.env.WEATHERAPI_KEY      ?? '',
      openweather:     keyOverrides.openweather     ?? process.env.OPENWEATHER_API_KEY ?? '',
      tomorrow:        keyOverrides.tomorrow        ?? process.env.TOMORROW_IO_KEY     ?? '',
    }

    const dates = lastNDates(city.tz, 8)
    const rows = await Promise.all(dates.map(async date => {
      const [actual, polymarket, open_meteo, visual_crossing, weatherapi, openweather, tomorrow] =
        await Promise.all([
          fetchOpenMeteoArchive(city, date),
          fetchPolymarket(city.slug, date),
          fetchOpenMeteo(city, date),
          fetchVisualCrossing(city, date, keys.visual_crossing),
          fetchWeatherApi(city, date, keys.weatherapi),
          fetchOpenWeather(city, date, keys.openweather),
          fetchTomorrow(city, date, keys.tomorrow),
        ])
      return {
        date, actual, polymarket,
        sources: { open_meteo, visual_crossing, weatherapi, openweather, tomorrow },
      }
    }))

    const tomorrowDate = cityTomorrow(city.tz)
    const [t_om, t_vc, t_wap, t_owm, t_tmr] = await Promise.all([
      fetchOpenMeteoForecast(city, tomorrowDate),
      fetchVisualCrossing(city, tomorrowDate, keys.visual_crossing),
      fetchWeatherApi(city, tomorrowDate, keys.weatherapi),
      fetchOpenWeather(city, tomorrowDate, keys.openweather),
      fetchTomorrow(city, tomorrowDate, keys.tomorrow),
    ])
    const tomorrowPoly = await fetchPolymarket(city.slug, tomorrowDate)

    return NextResponse.json({
      city: { key: cityKey, name: city.name, tz: city.tz, slug: city.slug },
      rows,
      tomorrowSources: {
        date: tomorrowDate,
        sources: {
          open_meteo: t_om, visual_crossing: t_vc, weatherapi: t_wap,
          openweather: t_owm, tomorrow: t_tmr,
        },
      },
      tomorrowPolymarket: tomorrowPoly,
    })
  } catch (e: any) {
    console.error('[/api/research-markets] Error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', cities: Object.keys(CITIES) })
}
