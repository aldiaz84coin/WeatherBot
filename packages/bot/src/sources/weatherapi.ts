// src/sources/weatherapi.ts
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

export class WeatherAPISource implements WeatherSource {
  name = 'WeatherAPI'
  slug = 'weatherapi'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: this.apiKey, q: 'Madrid', dt: targetDate, days: 1 },
    })
    return {
      date: targetDate,
      tmax: res.data.forecast.forecastday[0].day.maxtemp_c,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    const res = await axios.get('https://api.weatherapi.com/v1/history.json', {
      params: { key: this.apiKey, q: 'Madrid', dt: date },
    })
    return {
      date,
      tmax: res.data.forecast.forecastday[0].day.maxtemp_c,
      source: this.slug,
    }
  }
}
