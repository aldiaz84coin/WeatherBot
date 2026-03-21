// src/sources/meteored.ts
// TODO: implementar scraping de https://www.meteored.com
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

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
