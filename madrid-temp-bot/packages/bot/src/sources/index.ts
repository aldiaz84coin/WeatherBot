// src/sources/index.ts
// Interfaz común para todas las fuentes de datos meteorológicos
// y manager que las agrupa para el ensemble

import { format, subDays } from 'date-fns'

// ─── Tipos base ──────────────────────────────────────────────────────────────

export interface DailyForecast {
  date: string        // YYYY-MM-DD
  tmax: number        // temperatura máxima predicha (°C)
  tmin?: number
  source: string
  fetchedAt: string   // ISO timestamp
}

export interface HistoricalTemp {
  date: string        // YYYY-MM-DD
  tmax: number        // temperatura máxima real (°C)
  source: string
}

export interface WeatherSource {
  name: string
  slug: string

  // Predicción para mañana (o cualquier fecha futura próxima)
  getForecast(targetDate: string): Promise<DailyForecast>

  // Temperatura máxima real para una fecha pasada (para backtest)
  getHistorical(date: string): Promise<HistoricalTemp>
}

// ─── Resultado del ensemble ──────────────────────────────────────────────────

export interface EnsembleResult {
  date: string
  ensembleTemp: number
  sourceTemps: Record<string, number>
  weights: Record<string, number>
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class WeatherSourceManager {
  private sources: Map<string, WeatherSource> = new Map()
  private weights: Record<string, number> = {}

  register(source: WeatherSource, weight = 0.1) {
    this.sources.set(source.slug, source)
    this.weights[source.slug] = weight
  }

  setWeights(weights: Record<string, number>) {
    this.weights = weights
  }

  async getEnsembleForecast(targetDate: string): Promise<EnsembleResult> {
    const results = await Promise.allSettled(
      Array.from(this.sources.values()).map(async (src) => {
        const forecast = await src.getForecast(targetDate)
        return { slug: src.slug, tmax: forecast.tmax }
      })
    )

    const sourceTemps: Record<string, number> = {}
    for (const r of results) {
      if (r.status === 'fulfilled') {
        sourceTemps[r.value.slug] = r.value.tmax
      }
    }

    const ensembleTemp = this.computeWeightedAverage(sourceTemps)

    return {
      date: targetDate,
      ensembleTemp,
      sourceTemps,
      weights: { ...this.weights },
    }
  }

  async getHistoricalForDate(date: string): Promise<Record<string, number>> {
    const results = await Promise.allSettled(
      Array.from(this.sources.values()).map(async (src) => {
        const h = await src.getHistorical(date)
        return { slug: src.slug, tmax: h.tmax }
      })
    )

    const temps: Record<string, number> = {}
    for (const r of results) {
      if (r.status === 'fulfilled') {
        temps[r.value.slug] = r.value.tmax
      }
    }
    return temps
  }

  private computeWeightedAverage(sourceTemps: Record<string, number>): number {
    let total = 0
    let weightSum = 0

    for (const [slug, temp] of Object.entries(sourceTemps)) {
      const w = this.weights[slug] ?? 0
      total += temp * w
      weightSum += w
    }

    return weightSum > 0 ? total / weightSum : 0
  }

  getRegisteredSources(): string[] {
    return Array.from(this.sources.keys())
  }
}
