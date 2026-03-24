// src/sources/other-sources.ts
// Adaptadores para las fuentes 3–10
// Cada uno implementa WeatherSource con getForecast + getHistorical

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

// ─── Helper: Open-Meteo Archive como proxy histórico ─────────────────────────
// Usado por fuentes sin API histórica gratuita (TMR, ACU, OWM)

async function openMeteoHistorical(date: string, source: string): Promise<HistoricalTemp> {
  const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
    params: {
      latitude: MADRID_LAT,
      longitude: MADRID_LON,
      daily: 'temperature_2m_max',
      timezone: 'Europe/Madrid',
      start_date: date,
      end_date: date,
    },
    timeout: 10_000,
  })
  return { date, tmax: res.data.daily.temperature_2m_max[0], source }
}

// ─── 3. OpenWeatherMap ───────────────────────────────────────────────────────

export class OpenWeatherMapSource implements WeatherSource {
  name = 'OpenWeatherMap'
  slug = 'openweathermap'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    // API 2.5/forecast — gratuita (5 días, bloques de 3h)
    // La v3.0/onecall requiere plan de pago → 401 en free tier
    const res = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: {
        lat: MADRID_LAT,
        lon: MADRID_LON,
        appid: this.apiKey,
        units: 'metric',
        cnt: 40,
      },
      timeout: 10_000,
    })

    // Filtrar bloques de 3h que pertenecen al día objetivo y sacar el máximo
    const targetTemps: number[] = res.data.list
      .filter((item: any) => (item.dt_txt as string).startsWith(targetDate))
      .map((item: any) => item.main.temp_max as number)

    if (!targetTemps.length) throw new Error(`OWM: no data for ${targetDate}`)

    return {
      date: targetDate,
      tmax: Math.max(...targetTemps),
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // OWM historical requiere plan de pago → proxy Open-Meteo Archive
    return openMeteoHistorical(date, this.slug)
  }
}

// ─── 4. AccuWeather ──────────────────────────────────────────────────────────

export class AccuWeatherSource implements WeatherSource {
  name = 'AccuWeather'
  slug = 'accuweather'
  private locationKey = '308526'  // Madrid, Spain
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get(
      `https://dataservice.accuweather.com/forecasts/v1/daily/5day/${this.locationKey}`,
      { params: { apikey: this.apiKey, metric: true }, timeout: 10_000 }
    )
    const day = res.data.DailyForecasts.find((d: any) =>
      new Date(d.Date).toISOString().startsWith(targetDate)
    )
    if (!day) throw new Error(`AccuWeather: no forecast for ${targetDate}`)
    return {
      date: targetDate,
      tmax: day.Temperature.Maximum.Value,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // AccuWeather no tiene API histórica gratuita → proxy Open-Meteo Archive
    return openMeteoHistorical(date, this.slug)
  }
}

// ─── 5. WeatherAPI ───────────────────────────────────────────────────────────

export class WeatherAPISource implements WeatherSource {
  name = 'WeatherAPI'
  slug = 'weatherapi'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: this.apiKey, q: 'Madrid', dt: targetDate, days: 1 },
      timeout: 10_000,
    })
    const tmax = res.data.forecast.forecastday[0].day.maxtemp_c
    return { date: targetDate, tmax, source: this.slug, fetchedAt: new Date().toISOString() }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    const res = await axios.get('https://api.weatherapi.com/v1/history.json', {
      params: { key: this.apiKey, q: 'Madrid', dt: date },
      timeout: 10_000,
    })
    const tmax = res.data.forecast.forecastday[0].day.maxtemp_c
    return { date, tmax, source: this.slug }
  }
}

// ─── 6. Tomorrow.io ──────────────────────────────────────────────────────────

export class TomorrowIoSource implements WeatherSource {
  name = 'Tomorrow.io'
  slug = 'tomorrow-io'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get('https://api.tomorrow.io/v4/weather/forecast', {
      params: {
        location: `${MADRID_LAT},${MADRID_LON}`,
        timesteps: '1d',
        apikey: this.apiKey,
        units: 'metric',
      },
      timeout: 10_000,
    })
    const day = res.data.timelines.daily.find((d: any) =>
      (d.time as string).startsWith(targetDate)
    )
    if (!day) throw new Error(`Tomorrow.io: no forecast for ${targetDate}`)
    return {
      date: targetDate,
      tmax: day.values.temperatureMax,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Tomorrow.io no tiene histórico en free tier → proxy Open-Meteo Archive
    return openMeteoHistorical(date, this.slug)
  }
}

// ─── 7. Windy (ECMWF via Windy API) ─────────────────────────────────────────

export class WindySource implements WeatherSource {
  name = 'Windy'
  slug = 'windy'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.post('https://api.windy.com/api/point-forecast/v2', {
      lat: MADRID_LAT,
      lon: MADRID_LON,
      model: 'ecmwf',
      parameters: ['temp'],
      levels: ['surface'],
      key: this.apiKey,
    }, { timeout: 10_000 })

    const temps: number[] = []
    res.data.ts.forEach((ts: number, i: number) => {
      const d = new Date(ts).toISOString().split('T')[0]
      if (d === targetDate) temps.push(res.data['temp-surface'][i] - 273.15) // K → °C
    })

    if (!temps.length) throw new Error(`Windy: no data for ${targetDate}`)
    return { date: targetDate, tmax: Math.max(...temps), source: this.slug, fetchedAt: new Date().toISOString() }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Windy no tiene API histórica → proxy Open-Meteo Archive
    return openMeteoHistorical(date, this.slug)
  }
}

// ─── 8. Meteored (scraping) ──────────────────────────────────────────────────

export class MeteoredSource implements WeatherSource {
  name = 'Meteored'
  slug = 'meteored'

  async getForecast(_targetDate: string): Promise<DailyForecast> {
    throw new Error('Meteored: scraping not yet implemented')
  }

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    throw new Error('Meteored: historical not available')
  }
}
