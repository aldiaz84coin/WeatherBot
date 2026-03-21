// src/polymarket/market-discovery.ts
// Descubre todos los tokens de temperatura disponibles en Polymarket para una fecha dada.
// Usa primero el endpoint /events (más eficiente), con fallback a búsqueda por slug individual.
// Los resultados se cachean en Supabase para evitar llamadas repetidas a la API.

import axios from 'axios'
import { format } from 'date-fns'
import { supabase } from '../db/supabase'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TemperatureToken {
  slug: string
  tempCelsius: number
  price: number         // precio del token YES (0.0 – 1.0)
  tokenId: string
  resolved: boolean
  resolvedYes: boolean  // true si este token ganó (resolvió en YES)
}

export interface DayMarkets {
  date: string
  available: boolean    // hay mercados para este día en Polymarket
  tokens: TemperatureToken[]
  resolvedTemp: number | null  // temperatura ganadora (null si aún no resuelto)
  totalPriceSum: number        // suma de todos los precios (útil para el optimizador)
  fetchedAt: string
}

// ─── MarketDiscovery ──────────────────────────────────────────────────────────

export class MarketDiscovery {
  // Rango de temperaturas a explorar para Madrid (°C)
  // Cubre todas las estaciones con margen
  private readonly TEMP_RANGE = { min: 5, max: 43 }

  /**
   * Obtiene todos los tokens de temperatura disponibles para una fecha.
   * Intenta primero via /events (1 petición), luego fallback a slugs individuales.
   */
  async getMarketsForDate(date: string, useCache = true): Promise<DayMarkets> {
    // 1. Intentar desde cache de Supabase
    if (useCache) {
      const cached = await this.getCached(date)
      if (cached) {
        // Re-usar cache solo si el día ya está resuelto o si tiene tokens (mercado activo)
        if (cached.resolvedTemp !== null || cached.tokens.length > 0) {
          return cached
        }
      }
    }

    // 2. Intentar via endpoint /events (más eficiente)
    const daySlug = this.buildDaySlug(date)
    let result: DayMarkets | null = null

    try {
      result = await this.fetchViaEvents(daySlug, date)
    } catch (err) {
      console.warn(`[MarketDiscovery] /events falló para ${date}:`, (err as Error).message)
    }

    // 3. Fallback: buscar slugs individuales por temperatura
    if (!result || !result.available) {
      try {
        result = await this.fetchViaIndividualSlugs(date)
      } catch (err) {
        console.warn(`[MarketDiscovery] Fallback por slugs falló para ${date}:`, (err as Error).message)
      }
    }

    if (!result) {
      result = {
        date,
        available: false,
        tokens: [],
        resolvedTemp: null,
        totalPriceSum: 0,
        fetchedAt: new Date().toISOString(),
      }
    }

    // 4. Cachear resultado si tiene datos
    if (result.available || result.tokens.length === 0) {
      await this.cacheResult(date, result)
    }

    return result
  }

  /**
   * Consulta el endpoint /events de Gamma API.
   * Un evento del tipo "Madrid highest temp on DATE" contiene TODOS los mercados de temperatura.
   */
  private async fetchViaEvents(daySlug: string, date: string): Promise<DayMarkets> {
    const res = await axios.get(`${GAMMA_BASE}/events`, {
      params: { slug: daySlug },
      timeout: 15000,
    })

    const events = Array.isArray(res.data) ? res.data : []
    if (!events.length) {
      // Intentar también con el slug del mercado directo
      return await this.fetchViaMarketsSearch(date)
    }

    const event = events[0]
    const markets: any[] = event.markets || []

    return this.parseMarketsFromList(markets, date)
  }

  /**
   * Busca mercados usando el endpoint /markets con tag o title search.
   */
  private async fetchViaMarketsSearch(date: string): Promise<DayMarkets> {
    const dateStr = this.buildDaySlug(date)

    const res = await axios.get(`${GAMMA_BASE}/markets`, {
      params: {
        tag: 'weather',
        slug_contains: `highest-temperature-in-madrid-on-${dateStr.replace('highest-temperature-in-madrid-on-', '')}`,
        limit: 50,
      },
      timeout: 15000,
    })

    const markets = Array.isArray(res.data) ? res.data : []
    return this.parseMarketsFromList(markets, date)
  }

  /**
   * Fallback: prueba slugs individuales para cada temperatura del rango.
   * Más lento pero funciona cuando el endpoint /events no devuelve resultados.
   */
  private async fetchViaIndividualSlugs(date: string): Promise<DayMarkets> {
    const dateForSlug = this.formatDateForSlug(date)
    const temps = Array.from(
      { length: this.TEMP_RANGE.max - this.TEMP_RANGE.min + 1 },
      (_, i) => i + this.TEMP_RANGE.min
    )

    console.log(`[MarketDiscovery] Buscando slugs individuales para ${date} (${temps.length} temperaturas)...`)

    // Limitar concurrencia para no saturar la API
    const BATCH_SIZE = 8
    const markets: any[] = []

    for (let i = 0; i < temps.length; i += BATCH_SIZE) {
      const batch = temps.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.allSettled(
        batch.map(async (temp) => {
          const slug = `highest-temperature-in-madrid-${temp}c-on-${dateForSlug}`
          const res = await axios.get(`${GAMMA_BASE}/markets`, {
            params: { slug },
            timeout: 8000,
          })
          const data = Array.isArray(res.data) ? res.data : []
          if (data.length > 0) return { temp, market: data[0] }
          return null
        })
      )

      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          markets.push(r.value.market)
        }
      }

      // Pequeña pausa entre batches
      if (i + BATCH_SIZE < temps.length) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }

    return this.parseMarketsFromList(markets, date)
  }

  /**
   * Parsea una lista de markets de la Gamma API y extrae los tokens de temperatura.
   */
  private parseMarketsFromList(markets: any[], date: string): DayMarkets {
    const tokens: TemperatureToken[] = []
    let resolvedTemp: number | null = null

    for (const market of markets) {
      // Extraer temperatura del slug: highest-temperature-in-madrid-Xc-on-...
      const tempMatch = (market.slug || '').match(/-(\d+)c-on-/)
      if (!tempMatch) continue

      const tempCelsius = parseInt(tempMatch[1])

      // El mercado puede tener tokens como array o como propiedad
      const tokenList: any[] = market.tokens || market.outcomes || []
      const yesToken = tokenList.find((t: any) =>
        (t.outcome || t.name || '').toLowerCase() === 'yes'
      )

      if (!yesToken) continue

      const price = parseFloat(yesToken.price ?? yesToken.outcomePrices?.[0] ?? '0')
      if (isNaN(price)) continue

      const resolved = market.closed === true || market.resolved === true || market.resolutionTime !== null
      const resolvedPrice = parseFloat(market.resolvedPrice ?? market.resolved_price ?? 'NaN')
      const resolvedYes = resolved && resolvedPrice === 1

      if (resolvedYes) resolvedTemp = tempCelsius

      tokens.push({
        slug: market.slug || '',
        tempCelsius,
        price,
        tokenId: yesToken.tokenId || yesToken.token_id || '',
        resolved,
        resolvedYes,
      })
    }

    // Ordenar por temperatura
    tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)

    const totalPriceSum = tokens.reduce((sum, t) => sum + t.price, 0)

    return {
      date,
      available: tokens.length > 0,
      tokens,
      resolvedTemp,
      totalPriceSum: parseFloat(totalPriceSum.toFixed(4)),
      fetchedAt: new Date().toISOString(),
    }
  }

  // ─── Cache ──────────────────────────────────────────────────────────────────

  private async getCached(date: string): Promise<DayMarkets | null> {
    try {
      const { data } = await supabase
        .from('market_data_cache')
        .select('payload, fetched_at')
        .eq('market_date', date)
        .single()

      if (!data) return null

      const payload = data.payload as DayMarkets
      // Re-fetch si: no está resuelto y tiene más de 1 hora
      const ageMs = Date.now() - new Date(data.fetched_at).getTime()
      if (!payload.resolvedTemp && ageMs > 60 * 60 * 1000) return null

      return payload
    } catch {
      return null
    }
  }

  private async cacheResult(date: string, result: DayMarkets): Promise<void> {
    try {
      await supabase.from('market_data_cache').upsert({
        market_date: date,
        payload: result,
        fetched_at: result.fetchedAt,
      }, { onConflict: 'market_date' })
    } catch (err) {
      console.warn('[MarketDiscovery] No se pudo cachear:', (err as Error).message)
    }
  }

  // ─── Helpers de slug ────────────────────────────────────────────────────────

  private buildDaySlug(date: string): string {
    return `highest-temperature-in-madrid-on-${this.formatDateForSlug(date)}`
  }

  private formatDateForSlug(date: string): string {
    // "2026-03-21" → "march-21-2026"
    const d = new Date(date + 'T12:00:00')
    const months = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december',
    ]
    return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
  }

  // ─── Utilidades públicas ────────────────────────────────────────────────────

  /**
   * Devuelve tokens disponibles para una fecha desde la cache (sin hacer fetch).
   */
  async getCachedMarkets(date: string): Promise<DayMarkets | null> {
    return this.getCached(date)
  }

  /**
   * Pre-carga un rango de fechas en batch (útil antes de un backtest).
   * Devuelve el número de fechas con mercados encontrados.
   */
  async prefetchDateRange(dates: string[], logFn?: (msg: string) => void): Promise<number> {
    let found = 0
    for (const date of dates) {
      try {
        const result = await this.getMarketsForDate(date, true)
        if (result.available) found++
        if (logFn) logFn(`[${date}] ${result.available ? `✓ ${result.tokens.length} tokens` : '✗ sin mercado'}`)
      } catch (err) {
        if (logFn) logFn(`[${date}] Error: ${(err as Error).message}`)
      }
      // Rate limiting suave
      await new Promise(r => setTimeout(r, 100))
    }
    return found
  }
}

// Instancia global reutilizable
export const marketDiscovery = new MarketDiscovery()
