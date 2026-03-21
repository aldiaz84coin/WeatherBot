// src/sources/openweathermap.ts
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

export class OpenWeatherMapSource implements WeatherSource {
  name = 'OpenWeatherMap'
  slug = 'openweathermap'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
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
    const ts = Math.floor(new Date(date).getTime() / 1000)
    const res = await axios.get('https://api.openweathermap.org/data/3.0/onecall/timemachine', {
      params: { lat: MADRID_LAT, lon: MADRID_LON, dt: ts, appid: this.apiKey, units: 'metric' },
    })
    const tmax = Math.max(...res.data.data.map((h: any) => h.temp))
    return { date, tmax, source: this.slug }
  }
}
