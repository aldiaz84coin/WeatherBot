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

export interface ComparisonResponse {
  rows: DayRow[]
  keysConfigured: Record<string, boolean>
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
      const match = (m.slug ?? '').match(/-(\d+)c-on-/)
      if (!match) continue
      const tempC = parseInt(match[1])

      // ¿Resuelto?
      if (parseFloat(m.resolvedPrice) === 1) {
        resolvedTemp = tempC
        break
      }

      // Token YES con mayor precio = temperatura más probable
      const tokens: any[] = m.tokens ?? []
      const yes = tokens.find(t => (t.outcome ?? '').toLowerCase() === 'yes')
      if (!yes) continue
      const p = parseFloat(yes.price ?? 0)
      if (p > maxPrice) { maxPrice = p; maxTemp = tempC }
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

// ─── Open-Meteo (gratuita, sin key) ──────────────────────────────────────────

async function fetchOpenMeteo(date: string): Promise<SourceResult> {
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${MADRID_LAT}&longitude=${MADRID_LON}&daily=temperature_2m_max&timezone=Europe%2FMadrid&start_date=${date}&end_date=${date}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.daily?.temperature_2m_max?.[0]
    if (tmax == null) throw new Error('Sin datos de temperatura')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── AEMET ────────────────────────────────────────────────────────────────────

async function fetchAemet(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    // Estación 3195 = Madrid Retiro (referencia oficial)
    const url = `https://opendata.aemet.es/opendata/api/valores/climatologicos/diarios/datos/fechaini/${date}T00:00:00UTC/fechafin/${date}T23:59:59UTC/estacion/3195?api_key=${key}`
    const r1 = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r1.ok) throw new Error(`AEMET auth HTTP ${r1.status}`)
    const link = await r1.json()
    if (!link?.datos) throw new Error('Sin link de datos en respuesta AEMET')

    const r2 = await fetch(link.datos, { signal: AbortSignal.timeout(10_000) })
    if (!r2.ok) throw new Error(`AEMET datos HTTP ${r2.status}`)
    const data = await r2.json()

    if (!Array.isArray(data) || !data[0]) throw new Error('Datos AEMET vacíos')
    const raw = data[0].tmax
    if (!raw) throw new Error('Campo tmax no disponible')
    const tmax = parseFloat(String(raw).replace(',', '.'))
    if (isNaN(tmax)) throw new Error(`tmax inválido: ${raw}`)
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── OpenWeatherMap ───────────────────────────────────────────────────────────

async function fetchOpenWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const dt = Math.floor(new Date(date + 'T12:00:00Z').getTime() / 1000)
    const url = `https://api.openweathermap.org/data/3.0/onecall/timemachine?lat=${MADRID_LAT}&lon=${MADRID_LON}&dt=${dt}&appid=${key}&units=metric`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      throw new Error(err?.message ?? `HTTP ${res.status}`)
    }
    const d = await res.json() as any
    const hourlyTemps: number[] = (d.data ?? []).map((h: any) => h.temp).filter((v: any) => typeof v === 'number')
    if (!hourlyTemps.length) throw new Error('Sin datos horarios')
    return { tmax: Math.round(Math.max(...hourlyTemps) * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── Tomorrow.io ──────────────────────────────────────────────────────────────

async function fetchTomorrow(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.tomorrow.io/v4/timelines?location=${MADRID_LAT},${MADRID_LON}&fields=temperatureMax&timesteps=1d&startTime=${date}T00:00:00Z&endTime=${date}T23:59:59Z&units=metric&apikey=${key}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      throw new Error(err?.message ?? `HTTP ${res.status}`)
    }
    const d = await res.json() as any
    const intervals = d?.data?.timelines?.[0]?.intervals
    if (!intervals?.length) throw new Error('Sin intervalos en respuesta')
    const tmax = intervals[0]?.values?.temperatureMax
    if (tmax == null) throw new Error('temperatureMax no disponible')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── Visual Crossing ──────────────────────────────────────────────────────────

async function fetchVisualCrossing(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(MADRID_QUERY)}/${date}/${date}?unitGroup=metric&include=days&key=${key}&contentType=json`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json() as any
    const tmax = d?.days?.[0]?.tempmax
    if (tmax == null) throw new Error('tempmax no disponible')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── WeatherAPI ───────────────────────────────────────────────────────────────

async function fetchWeatherApi(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://api.weatherapi.com/v1/history.json?key=${key}&q=Madrid&dt=${date}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`)
    }
    const d = await res.json() as any
    const tmax = d?.forecast?.forecastday?.[0]?.day?.maxtemp_c
    if (tmax == null) throw new Error('maxtemp_c no disponible')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── AccuWeather ──────────────────────────────────────────────────────────────
// Histórico no disponible en plan gratuito, pero incluimos la fuente para
// mostrar forecast de los próximos días cuando el dashboard lo necesite.

async function fetchAccuWeather(date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  // Comprobamos si la fecha está en el rango del forecast gratuito (5 días)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date + 'T00:00:00')
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)

  if (diffDays < -1) {
    return { tmax: null, err: 'Histórico no disponible en plan gratuito' }
  }
  try {
    const url = `https://dataservice.accuweather.com/forecasts/v1/daily/5day/${ACCUWEATHER_LOCATION_KEY}?apikey=${key}&metric=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      throw new Error(err?.Message ?? `HTTP ${res.status}`)
    }
    const d = await res.json() as any
    const day = (d?.DailyForecasts ?? []).find((f: any) =>
      new Date(f.Date).toISOString().startsWith(date)
    )
    if (!day) throw new Error('Fecha no en ventana de forecast')
    const tmax = day?.Temperature?.Maximum?.Value
    if (tmax == null) throw new Error('Temperature.Maximum.Value no disponible')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) {
    return { tmax: null, err: e.message?.substring(0, 80) }
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      dates?: string[]
      keyOverrides?: Record<string, string>
    }

    const dates = body.dates ?? getLast8Days()
    const overrides = body.keyOverrides ?? {}

    // Resolver keys: override > env var
    const keys = {
      aemet:          overrides.aemet          ?? process.env.AEMET_API_KEY          ?? '',
      openweather:    overrides.openweather    ?? process.env.OPENWEATHER_API_KEY    ?? '',
      tomorrow:       overrides.tomorrow       ?? process.env.TOMORROW_IO_KEY        ?? '',
      visual_crossing: overrides.visual_crossing ?? process.env.VISUAL_CROSSING_KEY ?? '',
      weatherapi:     overrides.weatherapi     ?? process.env.WEATHERAPI_KEY         ?? '',
      accuweather:    overrides.accuweather    ?? process.env.ACCUWEATHER_API_KEY    ?? '',
    }

    // Informar al cliente qué keys están configuradas (sin exponer los valores)
    const keysConfigured = Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, v.length > 0])
    )

    // Fetch en paralelo por fecha
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
            fetchOpenMeteo(date),  // siempre disponible
          ])

        return {
          date,
          polymarket,
          sources: { aemet, openweather, tomorrow, visual_crossing, weatherapi, accuweather, open_meteo },
        }
      })
    )

    return NextResponse.json({ rows, keysConfigured } satisfies ComparisonResponse)
  } catch (e: any) {
    console.error('[/api/comparison] Error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET rápido para verificar que el endpoint está operativo
export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: '/api/comparison' })
}
