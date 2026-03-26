// src/polymarket/gamma.ts
// Cliente para la Gamma API de Polymarket
//
// Mecanismo idéntico al dashboard (/api/markets/route.ts):
//   1. Llama a /events?slug=<daySlug>  (daySlug = "highest-temperature-in-madrid-on-march-27-2026")
//   2. Obtiene todos los sub-mercados de events[0].markets
//   3. Extrae precio YES de outcomePrices[0] (string JSON)
//   4. Extrae temperatura de groupItemTitle o del suffix del slug sub-mercado

import axios from 'axios'
import { buildDaySlug } from './slugs'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface PolymarketToken {
  tokenId:     string
  outcome:     string   // "Yes" | "No"
  price:       number   // precio YES (0.0 – 1.0)
  slug:        string   // slug del sub-mercado
  tempCelsius: number   // temperatura que representa este token
  label:       string   // "18°C" | "14°C or below" | "24°C or higher"
}

export interface DayTokens {
  available:    boolean
  tokens:       PolymarketToken[]
  resolvedTemp: number | null
}

// ─── Gamma API client ─────────────────────────────────────────────────────────

export class GammaClient {

  /**
   * Obtiene todos los tokens de temperatura para una fecha.
   * Usa /events?slug=<daySlug> → events[0].markets, igual que el dashboard.
   */
  async getTokensForDate(date: string): Promise<DayTokens> {
    const daySlug = buildDaySlug(date)

    try {
      const res = await axios.get(`${GAMMA_BASE}/events`, {
        params: { slug: daySlug },
        timeout: 12_000,
      })

      const events: any[] = Array.isArray(res.data) ? res.data : []
      if (!events.length) return { available: false, tokens: [], resolvedTemp: null }

      const markets: any[] = events[0].markets ?? []
      return this.parseMarkets(markets)
    } catch (err) {
      console.error(`[Gamma] Error fetching tokens for ${date} (slug: ${daySlug}):`, err)
      return { available: false, tokens: [], resolvedTemp: null }
    }
  }

  /**
   * Obtiene el precio YES de un token específico por temperatura.
   * Shortcut: llama a getTokensForDate y filtra por tempCelsius.
   */
  async getTokenPrice(date: string, tempCelsius: number): Promise<number | null> {
    const { tokens } = await this.getTokensForDate(date)
    const token = tokens.find(t => t.tempCelsius === Math.round(tempCelsius))
    return token?.price ?? null
  }

  // ─── Parseo de markets (idéntico a parseTokens del dashboard) ──────────────

  private parseMarkets(markets: any[]): DayTokens {
    const tokens: PolymarketToken[] = []
    let resolvedTemp: number | null = null

    for (const m of markets) {
      // ── Temperatura ──────────────────────────────────────────────────────
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

      // ── Precio YES ───────────────────────────────────────────────────────
      // outcomePrices: string JSON "[\"0.39\", \"0.61\"]"  (índice 0 = YES)
      let price = 0
      try {
        const prices: string[] = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (m.outcomePrices ?? [])
        price = parseFloat(prices[0] ?? '0') || 0
        if (isNaN(price)) price = 0
      } catch { price = 0 }

      // ── Token ID YES ─────────────────────────────────────────────────────
      // clobTokenIds: string JSON "[\"<yes_id>\", \"<no_id>\"]"
      let tokenId = ''
      try {
        const ids: string[] = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : (m.clobTokenIds ?? [])
        tokenId = ids[0] ?? ''
      } catch { tokenId = '' }

      // ── Resolución ───────────────────────────────────────────────────────
      const resolved = m.closed === true
      const resolvedYes =
        (resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1) ||
        price >= 0.99 ||
        parseFloat(m.lastTradePrice ?? '0') >= 0.99

      if (resolvedYes) resolvedTemp = tempCelsius

      tokens.push({
        tokenId,
        outcome:     'Yes',
        price,
        slug:        m.slug ?? '',
        tempCelsius,
        label:       label || `${tempCelsius}°C`,
      })
    }

    tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)

    return {
      available:    tokens.length > 0,
      tokens,
      resolvedTemp,
    }
  }
}

// Re-export para retrocompatibilidad
export { buildDaySlug }
