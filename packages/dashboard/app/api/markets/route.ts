// app/api/markets/route.ts
// Devuelve los tokens de Polymarket para una fecha específica.
// Intenta primero desde el cache de Supabase, luego hace fetch real.
// Usado por PolymarketSimPanel y MarketDataPanel del dashboard.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Fecha inválida (usa YYYY-MM-DD)' }, { status: 400 })
  }

  // 1. Intentar desde cache — SOLO si tiene tokens (no cachear fallos)
  const { data: cached } = await supabase
    .from('market_data_cache')
    .select('payload, fetched_at')
    .eq('market_date', date)
    .single()

  if (cached?.payload) {
    const payload = cached.payload as any
    // BUG FIX 3: Solo usar cache si tiene datos reales (tokens.length > 0)
    // Si fue cacheado con available:false por un fallo de red, reintentamos.
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime()
    const isResolved = payload.resolvedTemp !== null && payload.resolvedTemp !== undefined
    const hasTokens  = Array.isArray(payload.tokens) && payload.tokens.length > 0

    if (hasTokens || isResolved) {
      // Cache válido: tiene datos o ya está resuelto (no cambiará)
      return NextResponse.json({ ...payload, fromCache: true })
    }
    // Cache vacío y antiguo de más de 30 min → reintentar fetch
    if (ageMs < 30 * 60 * 1000) {
      return NextResponse.json({ ...payload, fromCache: true })
    }
    // Si tiene más de 30 min sin datos → caído cache, reintentamos
  }

  // 2. Fetch desde Polymarket Gamma API
  try {
    const dateForSlug = formatDateForSlug(date)
    const daySlug     = `highest-temperature-in-madrid-on-${dateForSlug}`

    let markets: any[] = []

    // ── Intento 1: /events (un solo request devuelve todos los sub-mercados) ──
    try {
      const eventsRes = await fetch(
        `${GAMMA_BASE}/events?slug=${encodeURIComponent(daySlug)}`,
        { signal: AbortSignal.timeout(10_000) }
      )
      if (eventsRes.ok) {
        const events = await eventsRes.json()
        if (Array.isArray(events) && events.length > 0) {
          markets = events[0].markets || []
        }
      }
    } catch (e) {
      console.warn('[/api/markets] /events falló:', e)
    }

    // ── Intento 2: /markets?slug=<daySlug> (a veces el event slug == market slug) ──
    if (markets.length === 0) {
      try {
        const mRes = await fetch(
          `${GAMMA_BASE}/markets?slug=${encodeURIComponent(daySlug)}&limit=1`,
          { signal: AbortSignal.timeout(8_000) }
        )
        if (mRes.ok) {
          const mData = await mRes.json()
          if (Array.isArray(mData) && mData.length > 0) {
            markets = mData
          }
        }
      } catch (e) {
        console.warn('[/api/markets] /markets?slug= falló:', e)
      }
    }

    // ── BUG FIX 2: Fallback por slugs individuales de temperatura ──
    // El parámetro slug_contains NO existe en Gamma API.
    // En su lugar probamos slugs individuales para cada °C del rango verosímil.
    if (markets.length === 0) {
      markets = await fetchViaIndividualSlugs(dateForSlug)
    }

    const tokens      = parseTokens(markets)
    const resolvedTemp = tokens.find(t => t.resolvedYes)?.tempCelsius ?? null
    const totalPriceSum = parseFloat(
      tokens.reduce((sum, t) => sum + t.price, 0).toFixed(4)
    )

    const result = {
      date,
      available:      tokens.length > 0,
      tokens,
      resolvedTemp,
      totalPriceSum,
      fetchedAt:      new Date().toISOString(),
      fromCache:      false,
    }

    // Cachear solo si tiene datos
    if (tokens.length > 0) {
      await supabase.from('market_data_cache').upsert(
        { market_date: date, payload: result, fetched_at: result.fetchedAt },
        { onConflict: 'market_date' }
      )
    }

    return NextResponse.json(result)

  } catch (err) {
    console.error('[/api/markets] Error inesperado:', err)
    return NextResponse.json(
      { error: 'Error conectando con Polymarket' },
      { status: 502 }
    )
  }
}

// ─── Fallback: slugs individuales por temperatura ────────────────────────────
// Rango de temperaturas razonables para Madrid
const TEMP_MIN = 5
const TEMP_MAX = 43
const BATCH_SIZE = 10

async function fetchViaIndividualSlugs(dateForSlug: string): Promise<any[]> {
  const temps = Array.from(
    { length: TEMP_MAX - TEMP_MIN + 1 },
    (_, i) => i + TEMP_MIN
  )

  const found: any[] = []

  for (let i = 0; i < temps.length; i += BATCH_SIZE) {
    const batch = temps.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map(async (temp) => {
        const slug = `highest-temperature-in-madrid-${temp}c-on-${dateForSlug}`
        const res = await fetch(
          `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`,
          { signal: AbortSignal.timeout(7_000) }
        )
        if (!res.ok) return null
        const data = await res.json()
        return Array.isArray(data) && data.length > 0 ? data[0] : null
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) found.push(r.value)
    }
    // Pequeña pausa entre batches para no saturar la API
    if (i + BATCH_SIZE < temps.length) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  return found
}

// ─── parseTokens ─────────────────────────────────────────────────────────────

function parseTokens(markets: any[]) {
  const tokens: {
    tempCelsius:  number
    price:        number
    resolvedYes:  boolean
    resolved:     boolean
    slug:         string
    tokenId:      string
  }[] = []

  for (const market of markets) {
    // Extraer temperatura del slug: highest-temperature-in-madrid-Xc-on-...
    const tempMatch = (market.slug || '').match(/-(\d+)c-on-/)
    if (!tempMatch) continue
    const tempCelsius = parseInt(tempMatch[1])

    // BUG FIX 1: La Gamma API a veces devuelve tokens como STRING JSON, no array
    let tokenList: any[] = []
    try {
      tokenList = typeof market.tokens === 'string'
        ? JSON.parse(market.tokens)
        : (Array.isArray(market.tokens) ? market.tokens : [])
    } catch {
      tokenList = []
    }

    const yesToken = tokenList.find((t: any) =>
      (t.outcome || '').toLowerCase() === 'yes'
    )
    if (!yesToken) continue

    const price = parseFloat(yesToken.price ?? '0')
    if (isNaN(price)) continue

    const resolved    = market.closed === true || market.resolved === true
    const resolvedYes = resolved && parseFloat(market.resolvedPrice ?? 'NaN') === 1

    tokens.push({
      tempCelsius,
      price,
      resolvedYes,
      resolved,
      slug:    market.slug,
      tokenId: yesToken.tokenId || yesToken.token_id || '',
    })
  }

  return tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)
}

// ─── formatDateForSlug ───────────────────────────────────────────────────────
// "2026-03-23" → "march-23-2026"

function formatDateForSlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}
