// src/sources/visual-crossing.ts
// Visual Crossing: mejor fuente para backtest histórico (tmax explícita)
// Documentación: https://www.visualcrossing.com/resources/documentation/weather-api/

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_QUERY = 'Madrid,Spain'

export class VisualCrossingSource implements WeatherSource {
  name = 'Visual Crossing'
  slug = 'visual-crossing'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get(
      `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(MADRID_QUERY)}/${targetDate}/${targetDate}`,
      {
        params: {
          unitGroup: 'metric',
          include: 'days',
          key: this.apiKey,
          contentType: 'json',
        },
      }
    )

    const day = res.data.days[0]
    return {
      date: targetDate,
      tmax: day.tempmax,
      tmin: day.tempmin,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    const res = await axios.get(
      `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(MADRID_QUERY)}/${date}/${date}`,
      {
        params: {
          unitGroup: 'metric',
          include: 'days',
          key: this.apiKey,
          contentType: 'json',
        },
      }
    )

    const day = res.data.days[0]
    return { date, tmax: day.tempmax, source: this.slug }
  }
}
