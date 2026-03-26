// src/polymarket/market-discovery.ts
// Descubre todos los tokens de temperatura disponibles en Polymarket para una fecha dada.
//
// Mecanismo IDÉNTICO al dashboard (/api/markets/route.ts):
//   1. GET /events?slug=highest-temperature-in-madrid-on-{date}
//   2. events[0].markets[] → sub-mercados con todos los tokens
//   3. Temperatura: groupItemTitle ("18°C") o suffix del slug ("-18c")
//   4. Precio YES: outcomePrices[0] (string JSON)
//   5. Token ID: clobTokenIds[0] (string JSON)

import axios from 'axios'
import { supabase } from '../db/supabase'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TemperatureToken {
  slug:        string
  tempCelsius: number
  label:       string   // "18°C" | "14°C or below" | "24°C or higher"
  price:       number   // precio del token YES (0.0 – 1.0)
  tokenId:     string
  resolved:    boolean
  resolvedYes: boolean
}

export interface DayMarkets {
  date:          string
  available:     boolean
  tokens:        TemperatureToken[]
  resolvedTemp:  number | null
  totalPriceSum: number
  fetchedAt:     string
}

// ─── MarketDiscovery ──────────────────────────────────────────────────────────

export class MarketDiscovery {

  async getMarketsForDate(date: string, useCache = true): Promise<DayMarkets> {
    // 1. Cache de Supabase
    if (useCache) {
      const cached = await this.getCached(date)
      if (cached && (cached.resolvedTemp !== null || cached.tokens.length > 0)) {
        return cached
      }
    }

    // 2. Fetch desde Gamma API via /events (igual que el dashboard)
    const result = await this.fetchViaEvents(date)

    // 3. Cachear si tiene datos
    if (result.available) {
      await this.cacheResult(date, result)
    }

    return result
  }

  // ─── Fetch via /events ────────────────────────────────────────────────────
  // Misma lógica que el dashboard: una sola llamada devuelve todos los sub-mercados

  private async fetchViaEvents(date: string): Promise<DayMarkets> {
    const daySlug = this.buildDaySlug(date)

    try {
      const res = await axios.get(`${GAMMA_BASE}/events`, {
        params: { slug: daySlug },
        timeout: 12_000,
      })

      const events: any[] = Array.isArray(res.data) ? res.data : []

      if (!events.length) {
        console.warn(`[MarketDiscovery] Sin evento para ${date} (slug: ${daySlug})`)
        return this.emptyResult(date)
      }

      const markets: any[] = events[0].markets ?? []

      if (!markets.length) {
        console.warn(`[MarketDiscovery] Evento encontrado pero sin sub-mercados para ${date}`)
        return this.emptyResult(date)
      }

      return this.parseMarkets(markets, date)

    } catch (err) {
      console.error(`[MarketDiscovery] Error fetching /events para ${date}:`, (err as Error).message)
      return this.emptyResult(date)
    }
  }

  // ─── parseMarkets (idéntico a parseTokens del dashboard) ─────────────────

  private parseMarkets(markets: any[], date: string): DayMarkets {
    const tokens: TemperatureToken[] = []
    let resolvedTemp: number | null = null

    for (const m of markets) {
      // ── Temperatura ────────────────────────────────────────────────────────
      // Estrategia 1: groupItemTitle → "18°C" / "14°C or below" / "24°C or higher"
      let tempCelsius: number | null = null
      const label: string = m.groupItemTitle ?? ''

      const titleMatch = label.match(/^(\d+)/)
      if (titleMatch) tempCelsius = parseInt(titleMatch[1])

      // Estrategia 2: suffix del slug → ...-18c / ...-14corbelow / ...-24corhigher
      if (tempCelsius === null) {
        const slugMatch = (m.slug ?? '').match(/-(\d+)c(?:orbelow|orhigher)?$/)
        if (slugMatch) tempCelsius = parseInt(slugMatch[1])
      }

      if (tempCelsius === null) continue

      // ── Precio YES ─────────────────────────────────────────────────────────
      // outcomePrices: string JSON "[\"0.39\", \"0.61\"]"  (índice 0 = YES)
      let price = 0
      try {
        const prices: string[] = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (m.outcomePrices ?? [])
        price = parseFloat(prices[0] ?? '0') || 0
        if (isNaN(price)) price = 0
      } catch { price = 0 }

      // ── Token ID YES ───────────────────────────────────────────────────────
      // clobTokenIds: string JSON "[\"<yes_id>\", \"<no_id>\"]"
      let tokenId = ''
      try {
        const ids: string[] = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : (m.clobTokenIds ?? [])
        tokenId = ids[0] ?? ''
      } catch { tokenId = '' }

      // ── Resolución ─────────────────────────────────────────────────────────
      const resolved = m.closed === true
      const resolvedYes =
        (resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1) ||
        price >= 0.99 ||
        parseFloat(m.lastTradePrice ?? '0') >= 0.99

      if (resolvedYes) resolvedTemp = tempCelsius

      tokens.push({
        slug:        m.slug ?? '',
        tempCelsius,
        label:       label || `${tempCelsius}°C`,
        price,
        tokenId,
        resolved:    resolved || resolvedYes,
        resolvedYes,
      })
    }

    tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)
    const totalPriceSum = parseFloat(tokens.reduce((s, t) => s + t.price, 0).toFixed(4))

    return {
      date,
      available:    tokens.length > 0,
      tokens,
      resolvedTemp,
      totalPriceSum,
      fetchedAt:    new Date().toISOString(),
    }
  }

  // ─── Cache ────────────────────────────────────────────────────────────────

  private async getCached(date: string): Promise<DayMarkets | null> {
    try {
      const { data } = await supabase
        .from('market_data_cache')
        .select('payload, fetched_at')
        .eq('market_date', date)
        .single()

      if (!data) return null

      const payload = data.payload as DayMarkets
      const ageMs   = Date.now() - new Date(data.fetched_at).getTime()
      // Re-fetch si no está resuelto y tiene más de 1 hora
      if (!payload.resolvedTemp && ageMs > 60 * 60 * 1000) return null

      return payload
    } catch {
      return null
    }
  }

  private async cacheResult(date: string, result: DayMarkets): Promise<void> {
    try {
      await supabase.from('market_data_cache').upsert(
        { market_date: date, payload: result, fetched_at: result.fetchedAt },
        { onConflict: 'market_date' }
      )
    } catch (err) {
      console.warn('[MarketDiscovery] No se pudo cachear:', (err as Error).message)
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildDaySlug(date: string): string {
    // "2026-03-26" → "highest-temperature-in-madrid-on-march-26-2026"
    const d = new Date(date + 'T12:00:00')
    const months = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december',
    ]
    return `highest-temperature-in-madrid-on-${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
  }

  private emptyResult(date: string): DayMarkets {
    return {
      date,
      available:     false,
      tokens:        [],
      resolvedTemp:  null,
      totalPriceSum: 0,
      fetchedAt:     new Date().toISOString(),
    }
  }

  // ─── Utilidades públicas ──────────────────────────────────────────────────

  async getCachedMarkets(date: string): Promise<DayMarkets | null> {
    return this.getCached(date)
  }

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
      await new Promise(r => setTimeout(r, 100))
    }
    return found
  }
}

// Instancia global reutilizable
export const marketDiscovery = new MarketDiscovery()
