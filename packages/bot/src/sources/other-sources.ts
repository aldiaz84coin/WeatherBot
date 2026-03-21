// src/sources/other-sources.ts
// Adaptadores para las fuentes 3–10
// Cada uno implementa WeatherSource con getForecast + getHistorical

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

// ─── 3. OpenWeatherMap ───────────────────────────────────────────────────────

export class OpenWeatherMapSource implements WeatherSource {
  name = 'OpenWeatherMap'
  slug = 'openweathermap'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    // One Call API 3.0 — forecast diario
    const res = await axios.get('https://api.openweathermap.org/data/3.0/onecall', {
      params: {
        lat: MADRID_LAT, lon: MADRID_LON,
        exclude: 'current,minutely,hourly,alerts',
        appid: this.apiKey,
        units: 'metric',
      },
    })

    const targetTs = new Date(targetDate).getTime() / 1000
    const day = res.data.daily.find((d: any) => Math.abs(d.dt - targetTs) < 86400)
    if (!day) throw new Error(`OWM: no forecast for ${targetDate}`)

    return { date: targetDate, tmax: day.temp.max, source: this.slug, fetchedAt: new Date().toISOString() }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Historical API (requiere plan de pago; usar Open-Meteo como fallback en backtest)
    const ts = Math.floor(new Date(date).getTime() / 1000)
    const res = await axios.get('https://api.openweathermap.org/data/3.0/onecall/timemachine', {
      params: { lat: MADRID_LAT, lon: MADRID_LON, dt: ts, appid: this.apiKey, units: 'metric' },
    })
    const hourlyTemps = res.data.data.map((h: any) => h.temp)
    const tmax = Math.max(...hourlyTemps)
    return { date, tmax, source: this.slug }
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
      { params: { apikey: this.apiKey, metric: true } }
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

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    // AccuWeather no tiene API histórica gratuita — usar Open-Meteo como proxy en backtest
    throw new Error('AccuWeather: historical data not available in free tier — use open-meteo proxy')
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
    })
    const tmax = res.data.forecast.forecastday[0].day.maxtemp_c
    return { date: targetDate, tmax, source: this.slug, fetchedAt: new Date().toISOString() }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    const res = await axios.get('https://api.weatherapi.com/v1/history.json', {
      params: { key: this.apiKey, q: 'Madrid', dt: date },
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
    })
    const day = res.data.timelines.daily.find((d: any) => d.time.startsWith(targetDate))
    if (!day) throw new Error(`Tomorrow.io: no forecast for ${targetDate}`)
    return {
      date: targetDate,
      tmax: day.values.temperatureMax,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    throw new Error('Tomorrow.io: historical not supported in free tier')
  }
}

// ─── 7. Windy (ECMWF via Windy API) ─────────────────────────────────────────

export class WindySource implements WeatherSource {
  name = 'Windy'
  slug = 'windy'
  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    // Windy API devuelve datos horarios del modelo ECMWF
    const res = await axios.post('https://api.windy.com/api/point-forecast/v2', {
      lat: MADRID_LAT,
      lon: MADRID_LON,
      model: 'ecmwf',
      parameters: ['temp'],
      levels: ['surface'],
      key: this.apiKey,
    })

    // Filtrar horas del día objetivo y sacar el máximo
    const targetDay = targetDate
    const temps: number[] = []
    res.data.ts.forEach((ts: number, i: number) => {
      const d = new Date(ts).toISOString().split('T')[0]
      if (d === targetDay) temps.push(res.data['temp-surface'][i] - 273.15) // K → °C
    })

    if (!temps.length) throw new Error(`Windy: no data for ${targetDate}`)
    const tmax = Math.max(...temps)
    return { date: targetDate, tmax, source: this.slug, fetchedAt: new Date().toISOString() }
  }

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    throw new Error('Windy: no historical API — use open-meteo proxy')
  }
}

// ─── 8. Meteored (scraping) ──────────────────────────────────────────────────

export class MeteoredSource implements WeatherSource {
  name = 'Meteored'
  slug = 'meteored'

  async getForecast(targetDate: string): Promise<DailyForecast> {
    // TODO: implementar scraping de https://www.meteored.com/tiempo-en_madrid-America+Argentina+Buenos_Aires-1-14.html
    // Por ahora devuelve error para que el ensemble lo ignore
    throw new Error('Meteored: scraping not yet implemented')
  }

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    throw new Error('Meteored: historical not available')
  }
}

// ─── 9. Copernicus ERA5 (ground truth para backtest) ─────────────────────────

export class CopernicusSource implements WeatherSource {
  name = 'Copernicus ERA5'
  slug = 'copernicus'

  // ERA5 se accede via CDS API (requiere cdsapi Python client o HTTP directo)
  // Para el backtest usamos Open-Meteo Archive que está basado en ERA5

  async getForecast(_targetDate: string): Promise<DailyForecast> {
    throw new Error('Copernicus ERA5: not a forecast source — use for ground truth only')
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Proxy via Open-Meteo Archive (ERA5-land base, mismos datos)
    const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
      params: {
        latitude: MADRID_LAT, longitude: MADRID_LON,
        daily: 'temperature_2m_max',
        timezone: 'Europe/Madrid',
        start_date: date, end_date: date,
      },
    })
    const tmax = res.data.daily.temperature_2m_max[0]
    return { date, tmax, source: this.slug }
  }
}
