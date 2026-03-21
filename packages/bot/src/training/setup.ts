// src/training/setup.ts
// Inicializa el WeatherSourceManager con todas las fuentes disponibles

import 'dotenv/config'
import { WeatherSourceManager } from '../sources'
import { AemetSource } from '../sources/aemet'
import { OpenMeteoSource } from '../sources/open-meteo'
import { VisualCrossingSource } from '../sources/visual-crossing'
import { OpenWeatherMapSource } from '../sources/openweathermap'
import { AccuWeatherSource } from '../sources/accuweather'
import { WeatherAPISource } from '../sources/weatherapi'
import { TomorrowIoSource } from '../sources/tomorrow-io'
import { WindySource } from '../sources/windy'
import { MeteoredSource } from '../sources/meteored'
import { CopernicusSource } from '../sources/copernicus'

export async function setupManager(
  customWeights?: Record<string, number>
): Promise<WeatherSourceManager> {
  const manager = new WeatherSourceManager()

  // ── Fuentes gratuitas — siempre disponibles ─────────────────────────────
  manager.register(new OpenMeteoSource(), customWeights?.['open-meteo'] ?? 0.20)
  manager.register(new CopernicusSource(), customWeights?.copernicus ?? 0.10)

  // ── Fuentes con API key ──────────────────────────────────────────────────
  if (process.env.AEMET_API_KEY) {
    manager.register(new AemetSource(process.env.AEMET_API_KEY), customWeights?.aemet ?? 0.15)
  }
  if (process.env.VISUAL_CROSSING_KEY) {
    manager.register(new VisualCrossingSource(process.env.VISUAL_CROSSING_KEY), customWeights?.['visual-crossing'] ?? 0.15)
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
  if (process.env.TOMORROW_IO_KEY) {
    manager.register(new TomorrowIoSource(process.env.TOMORROW_IO_KEY), customWeights?.['tomorrow-io'] ?? 0.10)
  }

  // ── Fuentes opcionales (descomentar cuando tengas las keys) ──────────────
  // if (process.env.WINDY_KEY) {
  //   manager.register(new WindySource(process.env.WINDY_KEY), customWeights?.windy ?? 0.05)
  // }
  // manager.register(new MeteoredSource(), customWeights?.meteored ?? 0.05)

  const registered = manager.getRegisteredSources()
  console.log(`✅ WeatherSourceManager: ${registered.length} fuentes activas`)
  console.log(`   [${registered.join(', ')}]`)

  if (registered.length === 0) {
    throw new Error('No hay fuentes disponibles. Revisa las API keys en .env')
  }

  return manager
}
