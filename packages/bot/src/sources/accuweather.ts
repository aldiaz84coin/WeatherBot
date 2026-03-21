// src/sources/accuweather.ts
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const LOCATION_KEY = '308526' // Madrid, Spain

export class AccuWeatherSource implements WeatherSource {
  name = 'AccuWeather'
  slug = 'accuweather'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get(
      `https://dataservice.accuweather.com/forecasts/v1/daily/5day/${LOCATION_KEY}`,
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
    // No historical API en plan gratuito — el backtest usa open-meteo como proxy
    throw new Error('AccuWeather: historical not available in free tier')
  }
}
