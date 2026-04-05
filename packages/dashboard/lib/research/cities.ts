// packages/dashboard/lib/research/cities.ts
//
// Config de ciudades + fetchers compartidos entre los endpoints
// de /api/research-markets/*. Totalmente aislado del bot real.

export const CITIES = {
  london: {
    name: 'London', lat: 51.5074, lon: -0.1278,
    tz: 'Europe/London', tzShort: 'Europe%2FLondon',
    vcQuery: 'London,UK', slug: 'london',
  },
  milan: {
    name: 'Milan', lat: 45.4642, lon: 9.1900,
    tz: 'Europe/Rome', tzShort: 'Europe%2FRome',
    vcQuery: 'Milan,Italy', slug: 'milan',
  },
  munich: {
    name: 'Munich', lat: 48.1351, lon: 11.5820,
    tz: 'Europe/Berlin', tzShort: 'Europe%2FBerlin',
    vcQuery: 'Munich,Germany', slug: 'munich',
  },
  moscow: {
    name: 'Moscow', lat: 55.7558, lon: 37.6173,
    tz: 'Europe/Moscow', tzShort: 'Europe%2FMoscow',
    vcQuery: 'Moscow,Russia', slug: 'moscow',
  },
} as const

export type CityKey = keyof typeof CITIES
export type City = typeof CITIES[CityKey]

export const RESEARCH_SOURCES = [
  'open_meteo', 'visual_crossing', 'weatherapi', 'openweather', 'tomorrow',
] as const
export type ResearchSource = typeof RESEARCH_SOURCES[number]

export interface SourceResult { tmax: number | null; err: string | null }

// ─── Fechas en timezone de ciudad ────────────────────────────────────────────

export function cityToday(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}
export function cityTomorrow(tz: string): string {
  const t = new Date(); t.setUTCDate(t.getUTCDate() + 1)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t)
}
export function lastNDates(tz: string, n: number): string[] {
  const out: string[] = []
  for (let i = n; i >= 1; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i)
    out.push(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d))
  }
  return out
}
export function isPast(date: string, tz: string): boolean {
  return date < cityToday(tz)
}

// ─── Fetchers por fuente ─────────────────────────────────────────────────────

export async function fetchOpenMeteoArchive(city: City, date: string): Promise<SourceResult> {
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${city.tzShort}&start_date=${date}&end_date=${date}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.daily?.temperature_2m_max?.[0]
    if (tmax == null) throw new Error('Sin datos')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

export async function fetchOpenMeteoForecast(city: City, date: string): Promise<SourceResult> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${city.tzShort}&forecast_days=3`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const dates: string[] = d?.daily?.time ?? []
    const tmaxArr: number[] = d?.daily?.temperature_2m_max ?? []
    const idx = dates.indexOf(date)
    if (idx === -1) throw new Error('Fecha no encontrada')
    const tmax = tmaxArr[idx]
    if (tmax == null) throw new Error('Sin datos')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

export async function fetchOpenMeteo(city: City, date: string): Promise<SourceResult> {
  return isPast(date, city.tz) ? fetchOpenMeteoArchive(city, date) : fetchOpenMeteoForecast(city, date)
}

export async function fetchVisualCrossing(city: City, date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(city.vcQuery)}/${date}?unitGroup=metric&elements=tempmax&include=days&key=${key}&contentType=json`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.days?.[0]?.tempmax
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

export async function fetchWeatherApi(city: City, date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  try {
    const endpoint = isPast(date, city.tz) ? 'history' : 'forecast'
    const suffix = endpoint === 'forecast' ? '&days=1' : ''
    const url = `https://api.weatherapi.com/v1/${endpoint}.json?key=${key}&q=${encodeURIComponent(city.vcQuery)}&dt=${date}${suffix}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const tmax = d?.forecast?.forecastday?.[0]?.day?.maxtemp_c
    if (tmax == null) throw new Error('Sin tmax')
    return { tmax: Math.round(tmax * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

export async function fetchOpenWeather(city: City, date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  if (isPast(date, city.tz)) return { tmax: null, err: 'Sin histórico en free tier' }
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${city.lat}&lon=${city.lon}&appid=${key}&units=metric&cnt=40`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const temps: number[] = (d?.list ?? [])
      .filter((item: any) => (item.dt_txt as string).startsWith(date))
      .map((item: any) => item.main.temp_max as number)
    if (!temps.length) throw new Error('Fecha no encontrada')
    return { tmax: Math.round(Math.max(...temps) * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

export async function fetchTomorrow(city: City, date: string, key: string): Promise<SourceResult> {
  if (!key) return { tmax: null, err: 'Sin API key' }
  if (isPast(date, city.tz)) return { tmax: null, err: 'Sin histórico en free tier' }
  try {
    const url = `https://api.tomorrow.io/v4/weather/forecast?location=${city.lat},${city.lon}&timesteps=1h&apikey=${key}&units=metric`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const hours: any[] = d?.timelines?.hourly ?? []
    const dayTemps = hours
      .filter((h: any) => (h.time as string)?.substring(0, 10) === date)
      .map((h: any) => (h.values?.temperature ?? h.values?.temperatureMax) as number)
      .filter((t): t is number => t != null)
    if (!dayTemps.length) throw new Error('Fecha no encontrada')
    return { tmax: Math.round(Math.max(...dayTemps) * 10) / 10, err: null }
  } catch (e: any) { return { tmax: null, err: e.message?.substring(0, 60) } }
}

// ─── Polymarket best-effort ──────────────────────────────────────────────────

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']

export async function fetchPolymarket(citySlug: string, date: string): Promise<{
  temp: number | null; resolved: boolean; price: number | null; err: string | null
}> {
  try {
    const [y, m, d] = date.split('-').map(Number)
    const eventSlug = `highest-temperature-in-${citySlug}-on-${MONTHS[m - 1]}-${d}-${y}`
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const events = await res.json()
    const ev = Array.isArray(events) ? events[0] : null
    const markets: any[] = ev?.markets ?? []
    if (!markets.length) return { temp: null, resolved: false, price: null, err: 'Mercado no encontrado' }

    let maxPrice = -1, maxTemp: number | null = null, resolvedTemp: number | null = null
    for (const mk of markets) {
      const tempMatch = (mk.groupItemTitle ?? mk.question ?? '').match(/(-?\d+)\s*°?\s*C/i)
      if (!tempMatch) continue
      const tempC = parseInt(tempMatch[1], 10)
      const prices = typeof mk.outcomePrices === 'string' ? JSON.parse(mk.outcomePrices) : mk.outcomePrices
      const price = parseFloat(prices?.[0] ?? '0')
      const resolved = mk.closed === true
      const resolvedYes = resolved && parseFloat(mk.resolvedPrice ?? '0') >= 0.99
      if (resolvedYes) { resolvedTemp = tempC; break }
      if (price > maxPrice) { maxPrice = price; maxTemp = tempC }
    }
    const temp = resolvedTemp ?? maxTemp
    return {
      temp, resolved: resolvedTemp !== null,
      price: resolvedTemp !== null ? 1 : (maxPrice >= 0 ? maxPrice : null),
      err: temp === null ? 'Sin temperatura dominante' : null,
    }
  } catch (e: any) {
    return { temp: null, resolved: false, price: null, err: e.message?.substring(0, 60) }
  }
}

// ─── Helpers ensemble ────────────────────────────────────────────────────────

export function computeWeighted(
  sources: Record<string, SourceResult>,
  weights: Record<string, number>,
): number | null {
  let wSum = 0, vSum = 0
  for (const src of RESEARCH_SOURCES) {
    const v = sources[src]?.tmax
    const w = weights[src] ?? 0
    if (typeof v === 'number' && !isNaN(v) && w > 0) { vSum += v * w; wSum += w }
  }
  return wSum > 0 ? Math.round(vSum / wSum * 10) / 10 : null
}
