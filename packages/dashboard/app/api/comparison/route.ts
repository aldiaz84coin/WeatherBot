// packages/dashboard/app/api/comparison/route.ts
// Igual que la versión original + guarda automáticamente en historical_temperature_data
// todos los días resueltos que devuelve Polymarket.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026
const MADRID_QUERY = 'Madrid,Spain'
const ACCUWEATHER_LOCATION_KEY = '308526'
const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Cliente Supabase para escritura (service key) ────────────────────────────
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

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
    price: number | null
    err: string | null
  }
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

export interface TomorrowSources {
  date: string
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
  historicalSaved?: number
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

/** Devuelve true si la fecha es anterior a hoy */
function isPast(date: string): boolean {
  const today = new Date().toISOString().split('T')[0]
  return date < today
}

// ─── ⭐ Persistencia histórica ─────────────────────────────────────────────────

async function saveHistoricalData(rows: DayRow[]): Promise<number> {
  const resolvedRows = rows.filter(
    r => r.polymarket.resolved && r.polymarket.temp !== null
  )
  if (resolvedRows.length === 0) return 0

  const records = resolvedRows.map(row => ({
    date:                 row.date,
    polymarket_temp:      row.polymarket.temp,
    polymarket_resolved:  true,
    open_meteo_tmax:      row.sources.open_meteo.tmax      ?? null,
    aemet_tmax:           row.sources.aemet.tmax            ?? null,
    visual_crossing_tmax: row.sources.visual_crossing.tmax  ?? null,
    weatherapi_tmax:      row.sources.weatherapi.tmax       ?? null,
    openweather_tmax:     row.sources.openweather.tmax      ?? null,
    tomorrow_tmax:        row.sources.tomorrow.tmax         ?? null,
    accuweather_tmax:     row.sources.accuweather.tmax      ?? null,
    updated_at:           new Date().toISOString(),
  }))

  const supabase = getSupabase()
  const { error } = await supabase
    .from('historical_temperature_data')
    .upsert(records, { onConflict: 'date' })

  if (error) {
    console.warn('[comparison] Error guardando histórico:', error.message)
    return 0
  }

  console.log(`[comparison] ✅ ${records.length} registro(s) histórico(s) guardados`)
  return records.length
}

// ─── Polymarket ───────────────────────────────────────────────────────────────

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
      let tempC: number | null = null
      const label: string = m.groupItemTitle ?? ''
      const titleMatch = label.match(/^(\d+)/)
      if (titleMatch) tempC = parseInt(titleMatch[1])

      if (tempC === null) {
        const slugMatch = (m.slug ?? '').match(/-(\d+)c(?:orbelow|orhigher)?(?:-on-|$)/)
        if (slugMatch) tempC = parseInt(slugMatch[1])
      }
      if (tempC === null) continue

      let price = 0
      try {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (m.outcomePrices ?? [])
        price = parseFloat(prices?.[0] ?? '0')
        if (isNaN(price)) price = 0
      } catch { price = 0 }

      const resolved = m.closed === true
      const resolvedYes =
        (resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1) ||
        price >= 0.99 ||
        parseFloat(m.lastTradePrice ?? '0') >= 0.99

      if (resolvedYes) {
        resolvedTemp = tempC
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

// ─── Open-Meteo Archive (proxy histórico compartido) ──────────────────────────
// Usado como fallback para fuentes sin API histórica gratuita.

async function fetchOpenMeteoArchive(date: string): Promise<SourceResult> {
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

// ─── Open-Meteo forecast ──────────────────────────────────────────────────────

async function fetchOpenMeteoForecast(date: string): Promise<SourceResult> {
  try {
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

// Alias para el handler (las rows usan el archive, tomorrow usa el forecast)
async function fetchOpenMeteo(date: string): Promise<SourceResult> {
  return fetchOpenMeteoArchive(date)
}

// ─── AEMET ────────────────────────────────────────────────────────────────────
// Histórico: endpoint climatológico (estación Retiro 3195) — devuelve datos reales
// Forecast:  endpoint predicción municipal (28079) — devuelve hasta 7 días vista

async function fetchAemet(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }

  if (isPast(date)) {
    // ── Climatológico diario ──────────────────────────────────────────────────
    // Nota: AEMET tiene 1-2 días de retraso. Si falla, proxy Open-Meteo.
    try {
      const metaUrl = `https://opendata.aemet.es/opendata/api/valores/climatologicos/diarios/datos/fechaini/${date}T00:00:00UTC/fechafin/${date}T23:59:59UTC/estacion/3195/?api_key=${key}`
      const res1 = await fetch(metaUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res1.ok) throw new Error(`HTTP ${res1.status}`)
      const meta = await res1.json()
      if (meta.estado !== 200) throw new Error(meta.descripcion ?? 'Error AEMET')
      const res2 = await fetch(meta.datos, { signal: AbortSignal.timeout(10_000) })
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`)
      const data = await res2.json()
      const record = data?.[0]
      if (!record?.tmax) throw new Error('Campo tmax ausente')
      // AEMET usa coma como decimal en datos históricos
      const tmax = parseFloat(record.tmax.replace(',', '.'))
      if (isNaN(tmax)) throw new Error(`tmax no numérico: ${record.tmax}`)
      return { tmax, err: null }
    } catch (e: any) {
      // Fallback: Open-Meteo Archive
      console.warn(`[comparison] AEMET climatológico falló para ${date}: ${e.message} — usando Open-Meteo`)
      return fetchOpenMeteoArchive(date)
    }
  }

  // ── Predicción municipal (forecast) ──────────────────────────────────────────
  try {
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
// Histórico: proxy Open-Meteo Archive (OWM historical requiere plan de pago)
// Forecast:  /data/2.5/forecast — gratuito (3h blocks, 5 días)

async function fetchOpenWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }

  if (isPast(date)) {
    // OWM historical requiere plan de pago → proxy Open-Meteo Archive
    return fetchOpenMeteoArchive(date)
  }

  // Forecast gratuito: /data/2.5/forecast devuelve bloques de 3h
  // /data/2.5/forecast/daily requiere plan de pago → no usar
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${MADRID_LAT}&lon=${MADRID_LON}&appid=${key}&units=metric&cnt=40`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const list: any[] = d?.list ?? []
    // Filtrar bloques del día objetivo y sacar el máximo
    const temps = list
      .filter((item: any) => (item.dt_txt as string).startsWith(date))
      .map((item: any) => item.main.temp_max as number)
    if (!temps.length) throw new Error('Fecha no encontrada')
    return { tmax: Math.round(Math.max(...temps) * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Tomorrow.io ──────────────────────────────────────────────────────────────
// Histórico: proxy Open-Meteo Archive (Tomorrow no tiene histórico en free tier)
// Forecast:  endpoint estándar

async function fetchTomorrow(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }

  if (isPast(date)) {
    return fetchOpenMeteoArchive(date)
  }

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
// Soporta tanto histórico como forecast con el mismo endpoint timeline

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

// ─── WeatherAPI histórico ─────────────────────────────────────────────────────

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

// ─── WeatherAPI forecast ──────────────────────────────────────────────────────

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
// Histórico: proxy Open-Meteo Archive (AccuWeather no tiene histórico free)
// Forecast:  5-day endpoint estándar

async function fetchAccuWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }

  if (isPast(date)) {
    return fetchOpenMeteoArchive(date)
  }

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
      aemet:           keyOverrides.aemet            ?? process.env.AEMET_API_KEY          ?? '',
      openweather:     keyOverrides.openweather       ?? process.env.OPENWEATHER_API_KEY    ?? '',
      tomorrow:        keyOverrides.tomorrow          ?? process.env.TOMORROW_IO_KEY        ?? '',
      visual_crossing: keyOverrides.visual_crossing   ?? process.env.VISUAL_CROSSING_KEY    ?? '',
      weatherapi:      keyOverrides.weatherapi        ?? process.env.WEATHERAPI_KEY         ?? '',
      accuweather:     keyOverrides.accuweather       ?? process.env.ACCUWEATHER_API_KEY    ?? '',
    }

    const keysConfigured = Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, v.length > 0])
    )

    // ── Fetch en paralelo — datos históricos (últimos 8 días) ─────────────────
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
            fetchOpenMeteo(date),
          ])

        return {
          date,
          polymarket,
          sources: { aemet, openweather, tomorrow, visual_crossing, weatherapi, accuweather, open_meteo },
        }
      })
    )

    // ── ⭐ Guardar histórico automáticamente ──────────────────────────────────
    // Fire-and-forget: no bloqueamos la respuesta. Si falla, solo se loguea.
    const historicalSaved = await saveHistoricalData(rows).catch(() => 0)

    // ── Predicción para mañana ────────────────────────────────────────────────
    const tomorrowDate = getTomorrowDate()
    const [
      tmrAemet, tmrOpenweather, tmrTomorrow,
      tmrVisualCrossing, tmrWeatherapi, tmrAccuweather, tmrOpenMeteo,
    ] = await Promise.all([
      fetchAemet(tomorrowDate, keys.aemet),
      fetchOpenWeather(tomorrowDate, keys.openweather),
      fetchTomorrow(tomorrowDate, keys.tomorrow),
      fetchVisualCrossing(tomorrowDate, keys.visual_crossing),
      fetchWeatherApiForecast(tomorrowDate, keys.weatherapi),
      fetchAccuWeather(tomorrowDate, keys.accuweather),
      fetchOpenMeteoForecast(tomorrowDate),
    ])

    const tomorrowSources: TomorrowSources = {
      date: tomorrowDate,
      sources: {
        aemet:           tmrAemet,
        openweather:     tmrOpenweather,
        tomorrow:        tmrTomorrow,
        visual_crossing: tmrVisualCrossing,
        weatherapi:      tmrWeatherapi,
        accuweather:     tmrAccuweather,
        open_meteo:      tmrOpenMeteo,
      },
    }

    const response: ComparisonResponse = {
      rows,
      keysConfigured,
      tomorrowSources,
      historicalSaved,
    }
    return NextResponse.json(response)
  } catch (e: any) {
    console.error('[/api/comparison] Error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: '/api/comparison' })
}
