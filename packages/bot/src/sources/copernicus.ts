// src/sources/copernicus.ts
// Copernicus ERA5 — ground truth para backtest
// Proxy via Open-Meteo Archive (mismos datos ERA5-land, sin necesidad de CDS API)
import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

export class CopernicusSource implements WeatherSource {
  name = 'Copernicus ERA5'
  slug = 'copernicus'

  async getForecast(_targetDate: string): Promise<DailyForecast> {
    throw new Error('Copernicus ERA5: not a forecast source — use for ground truth only')
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
      params: {
        latitude: MADRID_LAT, longitude: MADRID_LON,
        daily: 'temperature_2m_max',
        timezone: 'Europe/Madrid',
        start_date: date, end_date: date,
      },
    })
    return { date, tmax: res.data.daily.temperature_2m_max[0], source: this.slug }
  }
}
