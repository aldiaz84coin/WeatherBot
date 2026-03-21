// src/sources/windy.ts
// Windy API — modelo ECMWF via point-forecast
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

export class WindySource implements WeatherSource {
  name = 'Windy'
  slug = 'windy'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.post('https://api.windy.com/api/point-forecast/v2', {
      lat: MADRID_LAT, lon: MADRID_LON,
      model: 'ecmwf',
      parameters: ['temp'],
      levels: ['surface'],
      key: this.apiKey,
    })

    const temps: number[] = []
    res.data.ts.forEach((ts: number, i: number) => {
      const d = new Date(ts).toISOString().split('T')[0]
      if (d === targetDate) temps.push(res.data['temp-surface'][i] - 273.15)
    })

    if (!temps.length) throw new Error(`Windy: no data for ${targetDate}`)
    return {
      date: targetDate,
      tmax: Math.max(...temps),
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(_date: string): Promise<HistoricalTemp> {
    throw new Error('Windy: no historical API — use open-meteo proxy')
  }
}
