// src/polymarket/slugs.ts + gamma.ts
// Lógica de slugs y lectura de mercados de Polymarket

import axios from 'axios'
import { format } from 'date-fns'

// ─── Slugs ────────────────────────────────────────────────────────────────────

// Formato: highest-temperature-in-madrid-on-march-21-2026
export function buildSlug(date: Date | string, tempCelsius: number): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const dateStr = format(d, 'MMMM-d-yyyy').toLowerCase()   // march-21-2026
  const tempRounded = Math.round(tempCelsius)
  return `highest-temperature-in-madrid-${tempRounded}c-on-${dateStr}`
}

// Slug del mercado general del día (sin temperatura específica)
export function buildDaySlug(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const dateStr = format(d, 'MMMM-d-yyyy').toLowerCase()
  return `highest-temperature-in-madrid-on-${dateStr}`
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PolymarketToken {
  tokenId: string
  outcome: string      // "Yes" | "No" o "≥36°C"
  price: number        // 0.0 – 1.0 (precio actual)
  slug: string
}

export interface PolymarketMarket {
  id: string
  slug: string
  question: string
  endDate: string
  active: boolean
  tokens: PolymarketToken[]
  resolvedPrice?: number   // 1 si resolvió YES, 0 si NO
}

// ─── Gamma API client ─────────────────────────────────────────────────────────

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export class GammaClient {
  async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
    try {
      const res = await axios.get(`${GAMMA_BASE}/markets`, {
        params: { slug },
      })
      const markets = res.data
      if (!markets || !markets.length) return null
      return this.normalizeMarket(markets[0])
    } catch (err) {
      console.error(`[Gamma] Error fetching market ${slug}:`, err)
      return null
    }
  }

  async getTokenPrice(slug: string): Promise<number | null> {
    const market = await this.getMarketBySlug(slug)
    if (!market) return null
    // El token YES para este tipo de mercado binario
    const yesToken = market.tokens.find((t) => t.outcome.toLowerCase() === 'yes')
    return yesToken?.price ?? null
  }

  // Para el backtest: obtener precio histórico de un token en una fecha dada
  async getHistoricalPrice(slug: string, date: string): Promise<number | null> {
    try {
      // Gamma API no tiene endpoint de precios históricos directo
      // Usar el precio de resolución como proxy
      const market = await this.getMarketBySlug(slug)
      if (!market) return null
      // Si el mercado ya resolvió, el precio era ~1.0 o ~0.0
      return market.resolvedPrice ?? null
    } catch {
      return null
    }
  }

  private normalizeMarket(raw: any): PolymarketMarket {
    return {
      id: raw.id,
      slug: raw.slug,
      question: raw.question,
      endDate: raw.endDate || raw.end_date_iso,
      active: raw.active,
      tokens: (raw.tokens || []).map((t: any) => ({
        tokenId: t.token_id,
        outcome: t.outcome,
        price: parseFloat(t.price ?? '0'),
        slug: raw.slug,
      })),
      resolvedPrice: raw.resolved_price !== undefined ? parseFloat(raw.resolved_price) : undefined,
    }
  }
}
