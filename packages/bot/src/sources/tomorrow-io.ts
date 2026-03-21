// src/sources/tomorrow-io.ts
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

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
