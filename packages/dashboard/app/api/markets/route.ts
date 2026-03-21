// app/api/markets/route.ts
// Devuelve los tokens de Polymarket para una fecha específica.
// Intenta primero desde el cache de Supabase, luego hace fetch real.
// Usado por el MarketDataPanel del dashboard.

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

  // 1. Intentar desde cache
  const { data: cached } = await supabase
    .from('market_data_cache')
    .select('payload, fetched_at')
    .eq('market_date', date)
    .single()

  if (cached?.payload) {
    return NextResponse.json({ ...cached.payload, fromCache: true })
  }

  // 2. Fetch desde Polymarket Gamma API
  try {
    const dateForSlug = formatDateForSlug(date)
    const daySlug = `highest-temperature-in-madrid-on-${dateForSlug}`

    // Intentar via /events primero
    let markets: any[] = []

    try {
      const eventsRes = await fetch(
        `${GAMMA_BASE}/events?slug=${encodeURIComponent(daySlug)}`,
        { signal: AbortSignal.timeout(10000) }
      )
      const events = await eventsRes.json()
      if (Array.isArray(events) && events.length > 0) {
        markets = events[0].markets || []
      }
    } catch {}

    // Fallback: /markets con tag
    if (markets.length === 0) {
      const marketsRes = await fetch(
        `${GAMMA_BASE}/markets?slug_contains=highest-temperature-in-madrid&limit=100`,
        { signal: AbortSignal.timeout(10000) }
      )
      const allMarkets = await marketsRes.json()
      markets = (Array.isArray(allMarkets) ? allMarkets : [])
        .filter((m: any) => m.slug?.includes(dateForSlug))
    }

    const tokens = parseTokens(markets)
    const resolvedTemp = tokens.find(t => t.resolvedYes)?.tempCelsius ?? null
    const totalPriceSum = parseFloat(
      tokens.reduce((sum, t) => sum + t.price, 0).toFixed(4)
    )

    const result = {
      date,
      available: tokens.length > 0,
      tokens,
      resolvedTemp,
      totalPriceSum,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    }

    // Cachear si tiene datos
    if (tokens.length > 0) {
      await supabase.from('market_data_cache').upsert({
        market_date: date,
        payload: result,
        fetched_at: result.fetchedAt,
      }, { onConflict: 'market_date' })
    }

    return NextResponse.json(result)

  } catch (err) {
    console.error('[/api/markets] Error:', err)
    return NextResponse.json(
      { error: 'Error conectando con Polymarket' },
      { status: 502 }
    )
  }
}

function parseTokens(markets: any[]) {
  const tokens: {
    tempCelsius: number
    price: number
    resolvedYes: boolean
    resolved: boolean
    slug: string
    tokenId: string
  }[] = []

  for (const market of markets) {
    const tempMatch = (market.slug || '').match(/-(\d+)c-on-/)
    if (!tempMatch) continue

    const tempCelsius = parseInt(tempMatch[1])
    const tokenList: any[] = market.tokens || []
    const yesToken = tokenList.find((t: any) =>
      (t.outcome || '').toLowerCase() === 'yes'
    )
    if (!yesToken) continue

    const price = parseFloat(yesToken.price ?? '0')
    const resolved = market.closed === true || market.resolved === true
    const resolvedYes = resolved && parseFloat(market.resolvedPrice ?? 'NaN') === 1

    tokens.push({
      tempCelsius,
      price,
      resolvedYes,
      resolved,
      slug: market.slug,
      tokenId: yesToken.tokenId || yesToken.token_id || '',
    })
  }

  return tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)
}

function formatDateForSlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}
