// src/sources/open-meteo.ts
// Open-Meteo: gratuita, sin API key, histórico desde 1940
// Documentación: https://open-meteo.com/en/docs/historical-weather-api

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_LAT = 40.4165
const MADRID_LON = -3.7026

export class OpenMeteoSource implements WeatherSource {
  name = 'Open-Meteo'
  slug = 'open-meteo'

  async getForecast(targetDate: string): Promise<DailyForecast> {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: MADRID_LAT,
        longitude: MADRID_LON,
        daily: 'temperature_2m_max',
        timezone: 'Europe/Madrid',
        start_date: targetDate,
        end_date: targetDate,
      },
    })

    const tmax = res.data.daily.temperature_2m_max[0]
    return {
      date: targetDate,
      tmax,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Open-Meteo Historical Weather API (ERA5-land base)
    const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
      params: {
        latitude: MADRID_LAT,
        longitude: MADRID_LON,
        daily: 'temperature_2m_max',
        timezone: 'Europe/Madrid',
        start_date: date,
        end_date: date,
      },
    })

    const tmax = res.data.daily.temperature_2m_max[0]
    return { date, tmax, source: this.slug }
  }
}
