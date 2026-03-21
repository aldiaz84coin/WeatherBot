// src/training/setup.ts
// Inicializa el WeatherSourceManager con todas las fuentes disponibles

import 'dotenv/config'
import { WeatherSourceManager } from '../sources'
import { AemetSource } from '../sources/aemet'
import { OpenMeteoSource } from '../sources/open-meteo'
import { VisualCrossingSource } from '../sources/visual-crossing'
import {
  OpenWeatherMapSource,
  AccuWeatherSource,
  WeatherAPISource,
  TomorrowIoSource,
  WindySource,
  MeteoredSource,
  CopernicusSource,
} from '../sources/other-sources'

export async function setupManager(
  customWeights?: Record<string, number>
): Promise<WeatherSourceManager> {
  const manager = new WeatherSourceManager()

  // Fuentes con API key
  if (process.env.AEMET_API_KEY) {
    manager.register(new AemetSource(process.env.AEMET_API_KEY), customWeights?.aemet ?? 0.15)
  }
  if (process.env.OPENWEATHER_API_KEY) {
    manager.register(new OpenWeatherMapSource(process.env.OPENWEATHER_API_KEY), customWeights?.openweathermap ?? 0.10)
  }
  if (process.env.ACCUWEATHER_API_KEY) {
    manager.register(new AccuWeatherSource(process.env.ACCUWEATHER_API_KEY), customWeights?.accuweather ?? 0.10)
  }
  if (process.env.WEATHERAPI_KEY) {
    manager.register(new WeatherAPISource(process.env.WEATHERAPI_KEY), customWeights?.weatherapi ?? 0.10)
  }
  if (process.env.VISUAL_CROSSING_KEY) {
    manager.register(new VisualCrossingSource(process.env.VISUAL_CROSSING_KEY), customWeights?.['visual-crossing'] ?? 0.15)
  }
  if (process.env.TOMORROW_IO_KEY) {
    manager.register(new TomorrowIoSource(process.env.TOMORROW_IO_KEY), customWeights?.['tomorrow-io'] ?? 0.10)
  }

  // Fuentes gratuitas (siempre disponibles)
  manager.register(new OpenMeteoSource(), customWeights?.['open-meteo'] ?? 0.20)
  manager.register(new CopernicusSource(), customWeights?.copernicus ?? 0.10)

  // Fuentes opcionales
  // manager.register(new WindySource(process.env.WINDY_KEY!), 0.05)
  // manager.register(new MeteoredSource(), 0.05)

  console.log(`✅ Manager inicializado con ${manager.getRegisteredSources().length} fuentes:`)
  console.log(`   ${manager.getRegisteredSources().join(', ')}`)

  return manager
}
