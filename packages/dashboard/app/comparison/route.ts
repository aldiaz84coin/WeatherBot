// packages/dashboard/app/api/comparison/route.ts
// Proxy server-side para las 6 fuentes meteorológicas + Polymarket Gamma API.
// Las API keys se leen de process.env (Vercel env vars) con posibilidad de
// override desde el body de la petición (para uso en local sin .env).
//
// POST /api/comparison
// Body: { dates: string[], keyOverrides?: { aemet?, openweather?, ... } }
// Response: ComparisonResponse

import { NextRequest, NextResponse } from 'next/server'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026
const MADRID_QUERY = 'Madrid,Spain'
const ACCUWEATHER_LOCATION_KEY = '308526'
const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SourceResult {
  tmax: number | null
  err: string | null
}

export interface DayRow {
  date: string
  polymarket: {
    temp: number | null
    resolved: boolean
    price: number | null   // precio del token más probable (0–1)
    err: string | null
  }
  sources: {
    aemet: SourceResult
    openweather: SourceResult
    tomorrow: SourceResult
    visual_crossing: SourceResult
    weatherapi: SourceResult
    accuweather: SourceResult
    open_meteo: SourceResult  // gratuita, siempre disponible
  }
}

export interface TomorrowSources {
  date: string   // fecha de mañana (YYYY-MM-DD)
  sources: {
    aemet: SourceResult
    openweather: SourceResult
    tomorrow: SourceResult
    visual_crossing: SourceResult
    weatherapi: SourceResult
    accuweather: SourceResult
    open_meteo: SourceResult
  }
}

export interface ComparisonResponse {
  rows: DayRow[]
  keysConfigured: Record<string, boolean>
  tomorrowSources?: TomorrowSources
}

// ─── Helpers de slug / fecha ──────────────────────────────────────────────────

function toSlugDate(dateStr: string): string {
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  const d = new Date(dateStr + 'T12:00:00')
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}

function getLast8Days(): string[] {
  const days: string[] = []
  for (let i = 8; i >= 1; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

function getTomorrowDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

// ─── Polymarket ───────────────────────────────────────────────────────────────
// FIX: antes usaba m.tokens (no existe en /events de Gamma).
// Ahora parsea m.outcomePrices (string JSON) igual que markets/route.ts,
// usa groupItemTitle para extraer temperatura y detecta resolución por
// resolvedPrice, price >= 0.99 o lastTradePrice >= 0.99.

async function fetchPolymarket(date: string): Promise<DayRow['polymarket']> {
  const slug = `highest-temperature-in-madrid-on-${toSlugDate(date)}`
  try {
    const res = await fetch(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(12_000),
      next: { revalidate: 300 },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const events = await res.json() as any[]
    if (!events?.length) return { temp: null, resolved: false, price: null, err: 'Sin mercado en Polymarket' }

    const markets: any[] = events[0]?.markets ?? []
    let maxPrice = -1
    let maxTemp: number | null = null
    let resolvedTemp: number | null = null

    for (const m of markets) {
      // ── Temperatura ──────────────────────────────────────────────────────
      // 1. Primero intentar desde groupItemTitle: "14°C or below" / "18°C"
      let tempC: number | null = null
      const label: string = m.groupItemTitle ?? ''
      const titleMatch = label.match(/^(\d+)/)
      if (titleMatch) tempC = parseInt(titleMatch[1])

      // 2. Fallback: slug del market — soporta -Xc, -Xcorbelow, -Xcorhigher
      if (tempC === null) {
        const slugMatch = (m.slug ?? '').match(/-(\d+)c(?:orbelow|orhigher)?(?:-on-|$)/)
        if (slugMatch) tempC = parseInt(slugMatch[1])
      }
      if (tempC === null) continue

      // ── Precio YES ───────────────────────────────────────────────────────
      // outcomePrices es un string JSON: "[\"0.39\", \"0.61\"]" (índice 0 = YES)
      let price = 0
      try {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (m.outcomePrices ?? [])
        price = parseFloat(prices?.[0] ?? '0')
        if (isNaN(price)) price = 0
      } catch { price = 0 }

      // ── Resolución ────────────────────────────────────────────────────────
      // Tres vías: closed+resolvedPrice=1, price≥0.99, lastTradePrice≥0.99
      const resolved   = m.closed === true
      const resolvedYes =
        (resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1) ||
        price >= 0.99 ||
        parseFloat(m.lastTradePrice ?? '0') >= 0.99

      if (resolvedYes) {
        resolvedTemp = tempC
        // No hacemos break para permitir que otro token tenga resolvedPrice=1 explícito
        // pero sí podemos salir si la resolución es oficial
        if (resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1) break
      }

      if (price > maxPrice) { maxPrice = price; maxTemp = tempC }
    }

    const temp = resolvedTemp ?? maxTemp
    return {
      temp,
      resolved: resolvedTemp !== null,
      price: resolvedTemp !== null ? 1 : (maxPrice >= 0 ? maxPrice : null),
      err: temp === null ? 'No se encontró temperatura dominante' : null,
    }
  } catch (e: any) {
    return { temp: null, resolved: false, price: null, err: e.message?.substring(0, 80) ?? 'Error desconocido' }
  }
}

// ─── Open-Meteo (gratuita, sin key) ── HISTÓRICO ──────────────────────────────

async function fetchOpenMeteo(date: string): Promise<SourceResult> {
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${MADRID_LAT}&longitude=${MADRID_LON}&daily=temperature_2m_max&timezone=Europe%2FMadrid&start_date=${date}&end_date=${date}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.daily?.temperature_2m_max?.[0]
    if (tmax == null) throw new Error('Sin datos')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Open-Meteo FORECAST (gratuita, sin key) ─────────────────────────────────

async function fetchOpenMeteoForecast(date: string): Promise<SourceResult> {
  try {
    // Pedimos 3 días de previsión para asegurarnos de cubrir mañana
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${MADRID_LAT}&longitude=${MADRID_LON}&daily=temperature_2m_max&timezone=Europe%2FMadrid&forecast_days=3`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const dates: string[] = d?.daily?.time ?? []
    const tmaxArr: number[] = d?.daily?.temperature_2m_max ?? []
    const idx = dates.indexOf(date)
    if (idx === -1) throw new Error('Fecha no encontrada en forecast')
    const tmax = tmaxArr[idx]
    if (tmax == null) throw new Error('Sin datos')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── AEMET ─────────────────────────────────────────────────────────────────────

async function fetchAemet(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    // AEMET predicción diaria Madrid (código 28079)
    const res1 = await fetch(
      `https://opendata.aemet.es/opendata/api/prediccion/especifica/municipio/diaria/28079/?api_key=${key}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (!res1.ok) throw new Error(`HTTP ${res1.status}`)
    const meta = await res1.json()
    if (meta.estado !== 200) throw new Error(meta.descripcion ?? 'Error AEMET')
    const res2 = await fetch(meta.datos, { signal: AbortSignal.timeout(10_000) })
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`)
    const data = await res2.json()
    const pred = data?.[0]?.prediccion?.dia ?? []
    const day = pred.find((d: any) => d.fecha?.startsWith(date))
    if (!day) throw new Error('Fecha no encontrada')
    const tmax = parseFloat(day.temperatura?.maxima)
    if (isNaN(tmax)) throw new Error('Sin tmax')
    return { tmax, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── OpenWeather ──────────────────────────────────────────────────────────────

async function fetchOpenWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast/daily?q=${encodeURIComponent(MADRID_QUERY)}&cnt=5&units=metric&appid=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const list: any[] = d?.list ?? []
    const target = list.find(item => {
      const dt = new Date(item.dt * 1000).toISOString().split('T')[0]
      return dt === date
    })
    if (!target) throw new Error('Fecha no encontrada')
    const tmax = target?.temp?.max
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Tomorrow.io ──────────────────────────────────────────────────────────────

async function fetchTomorrow(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.tomorrow.io/v4/weather/forecast?location=${MADRID_LAT},${MADRID_LON}&timesteps=1d&apikey=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const days: any[] = d?.timelines?.daily ?? []
    const target = days.find(item => item.time?.startsWith(date))
    if (!target) throw new Error('Fecha no encontrada')
    const tmax = target?.values?.temperatureMax
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Visual Crossing ──────────────────────────────────────────────────────────

async function fetchVisualCrossing(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(MADRID_QUERY)}/${date}?unitGroup=metric&elements=tempmax&include=days&key=${key}&contentType=json`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.days?.[0]?.tempmax
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── WeatherAPI ───────────────────────────────────────────────────────────────

async function fetchWeatherApi(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.weatherapi.com/v1/history.json?key=${key}&q=${encodeURIComponent(MADRID_QUERY)}&dt=${date}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.forecast?.forecastday?.[0]?.day?.maxtemp_c
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── WeatherAPI FORECAST ──────────────────────────────────────────────────────

async function fetchWeatherApiForecast(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${encodeURIComponent(MADRID_QUERY)}&dt=${date}&days=1`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.forecast?.forecastday?.[0]?.day?.maxtemp_c
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── AccuWeather ──────────────────────────────────────────────────────────────

async function fetchAccuWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://dataservice.accuweather.com/forecasts/v1/daily/5day/${ACCUWEATHER_LOCATION_KEY}?apikey=${key}&metric=true&details=false`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const days: any[] = d?.DailyForecasts ?? []
    const target = days.find(day => {
      const dt = new Date(day.Date).toISOString().split('T')[0]
      return dt === date
    })
    if (!target) throw new Error('Fecha no encontrada')
    const tmax = target?.Temperature?.Maximum?.Value
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const dates: string[] = body.dates ?? getLast8Days()
    const keyOverrides: Record<string, string> = body.keyOverrides ?? {}

    const keys = {
      aemet:          keyOverrides.aemet           ?? process.env.AEMET_API_KEY          ?? '',
      openweather:    keyOverrides.openweather      ?? process.env.OPENWEATHER_API_KEY    ?? '',
      tomorrow:       keyOverrides.tomorrow         ?? process.env.TOMORROW_IO_KEY        ?? '',
      visual_crossing: keyOverrides.visual_crossing ?? process.env.VISUAL_CROSSING_KEY   ?? '',
      weatherapi:     keyOverrides.weatherapi       ?? process.env.WEATHERAPI_KEY         ?? '',
      accuweather:    keyOverrides.accuweather      ?? process.env.ACCUWEATHER_API_KEY    ?? '',
    }

    // Informar al cliente qué keys están configuradas (sin exponer los valores)
    const keysConfigured = Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, v.length > 0])
    )

    // Fetch en paralelo por fecha (datos históricos)
    const rows: DayRow[] = await Promise.all(
      dates.map(async (date): Promise<DayRow> => {
        const [polymarket, aemet, openweather, tomorrow, visual_crossing, weatherapi, accuweather, open_meteo] =
          await Promise.all([
            fetchPolymarket(date),
            fetchAemet(date, keys.aemet),
            fetchOpenWeather(date, keys.openweather),
            fetchTomorrow(date, keys.tomorrow),
            fetchVisualCrossing(date, keys.visual_crossing),
            fetchWeatherApi(date, keys.weatherapi),
            fetchAccuWeather(date, keys.accuweather),
            fetchOpenMeteo(date),  // siempre disponible (histórico)
          ])

        return {
          date,
          polymarket,
          sources: { aemet, openweather, tomorrow, visual_crossing, weatherapi, accuweather, open_meteo },
        }
      })
    )

    // ── Predicción para mañana (APIs de forecast) ─────────────────────────
    const tomorrowDate = getTomorrowDate()
    const [
      tmrAemet, tmrOpenweather, tmrTomorrow,
      tmrVisualCrossing, tmrWeatherapi, tmrAccuweather, tmrOpenMeteo,
    ] = await Promise.all([
      fetchAemet(tomorrowDate, keys.aemet),
      fetchOpenWeather(tomorrowDate, keys.openweather),
      fetchTomorrow(tomorrowDate, keys.tomorrow),
      fetchVisualCrossing(tomorrowDate, keys.visual_crossing),
      fetchWeatherApiForecast(tomorrowDate, keys.weatherapi),  // forecast endpoint
      fetchAccuWeather(tomorrowDate, keys.accuweather),
      fetchOpenMeteoForecast(tomorrowDate),                    // forecast endpoint (gratis)
    ])

    const tomorrowSources: TomorrowSources = {
      date: tomorrowDate,
      sources: {
        aemet:          tmrAemet,
        openweather:    tmrOpenweather,
        tomorrow:       tmrTomorrow,
        visual_crossing: tmrVisualCrossing,
        weatherapi:     tmrWeatherapi,
        accuweather:    tmrAccuweather,
        open_meteo:     tmrOpenMeteo,
      },
    }

    return NextResponse.json({ rows, keysConfigured, tomorrowSources } satisfies ComparisonResponse)
  } catch (e: any) {
    console.error('[/api/comparison] Error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET rápido para verificar que el endpoint está operativo
export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: '/api/comparison' })
}
