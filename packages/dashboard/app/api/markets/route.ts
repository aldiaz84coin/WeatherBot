// app/api/markets/route.ts
// Devuelve los tokens de Polymarket para una fecha específica.
// Estructura real de la Gamma API (descubierta 2026-03-22):
//   - El endpoint /events?slug=<daySlug> devuelve todos los sub-mercados en events[0].markets
//   - Cada market NO tiene campo "tokens"; el precio YES está en outcomePrices[0] (string JSON)
//   - El tokenId YES está en clobTokenIds[0] (string JSON)
//   - Slugs de temperatura: ...-14corbelow | ...-15c | ... | ...-23c | ...-24corhigher
//   - La temperatura se lee también de groupItemTitle: "14°C or below" / "18°C" / "24°C or higher"

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

  // ── 1. Caché de Supabase ──────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from('market_data_cache')
    .select('payload, fetched_at')
    .eq('market_date', date)
    .single()

  if (cached?.payload) {
    const payload = cached.payload as any
    const hasTokens  = Array.isArray(payload.tokens) && payload.tokens.length > 0
    const isResolved = payload.resolvedTemp !== null && payload.resolvedTemp !== undefined
    const ageMs      = Date.now() - new Date(cached.fetched_at).getTime()

    // Cache válido si: tiene tokens, o ya está resuelto, o tiene menos de 30 min
    if (hasTokens || isResolved || ageMs < 30 * 60 * 1000) {
      return NextResponse.json({ ...payload, fromCache: true })
    }
  }

  // ── 2. Fetch desde Gamma API ──────────────────────────────────────────────
  try {
    const dateForSlug = formatDateForSlug(date)
    const daySlug     = `highest-temperature-in-madrid-on-${dateForSlug}`

    // El endpoint /events devuelve el evento con TODOS los sub-mercados incluidos
    const eventsRes = await fetch(
      `${GAMMA_BASE}/events?slug=${encodeURIComponent(daySlug)}`,
      { signal: AbortSignal.timeout(12_000) }
    )

    if (!eventsRes.ok) {
      throw new Error(`Gamma API respondió ${eventsRes.status}`)
    }

    const events = await eventsRes.json()

    if (!Array.isArray(events) || events.length === 0) {
      // Mercado aún no creado (fecha futura lejana)
      return NextResponse.json({
        date, available: false, tokens: [],
        resolvedTemp: null, totalPriceSum: 0,
        fetchedAt: new Date().toISOString(), fromCache: false,
      })
    }

    const markets: any[] = events[0].markets ?? []
    const tokens = parseTokens(markets)

    const resolvedTemp  = tokens.find(t => t.resolvedYes)?.tempCelsius ?? null
    const totalPriceSum = parseFloat(tokens.reduce((s, t) => s + t.price, 0).toFixed(4))

    const result = {
      date,
      available: tokens.length > 0,
      tokens,
      resolvedTemp,
      totalPriceSum,
      fetchedAt:  new Date().toISOString(),
      fromCache:  false,
    }

    // Cachear si tiene datos (o si ya está resuelto para no re-fetchear)
    if (tokens.length > 0) {
      await supabase.from('market_data_cache').upsert(
        { market_date: date, payload: result, fetched_at: result.fetchedAt },
        { onConflict: 'market_date' }
      )
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

// ─── parseTokens ──────────────────────────────────────────────────────────────
// Convierte los markets del evento en tokens normalizados.
//
// Estructura real del market:
//   slug:          "...-18c"  |  "...-14corbelow"  |  "...-24corhigher"
//   groupItemTitle: "18°C"    |  "14°C or below"   |  "24°C or higher"
//   outcomePrices: "[\"0.39\", \"0.61\"]"   (string JSON, índice 0 = YES)
//   clobTokenIds:  "[\"<id_yes>\", \"<id_no>\"]" (string JSON)
//   closed:        true/false
//   resolvedPrice: "1" | "0" | undefined  (solo cuando closed=true)

function parseTokens(markets: any[]) {
  const tokens: {
    tempCelsius:    number
    label:          string   // "14°C or below" | "18°C" | "24°C or higher"
    price:          number   // probabilidad YES (0.0 – 1.0)
    tokenId:        string
    resolved:       boolean
    resolvedYes:    boolean
    slug:           string
  }[] = []

  for (const m of markets) {
    // ── Temperatura ────────────────────────────────────────────────────────
    // Primero intentar desde groupItemTitle: "14°C or below" / "18°C" / "24°C or higher"
    let tempCelsius: number | null = null
    const label: string = m.groupItemTitle ?? ''

    const titleMatch = label.match(/^(\d+)/)
    if (titleMatch) {
      tempCelsius = parseInt(titleMatch[1])
    }

    // Fallback: extraer del slug: ...-18c, ...-14corbelow, ...-24corhigher
    if (tempCelsius === null) {
      const slugMatch = (m.slug ?? '').match(/-(\d+)c(?:orbelow|orhigher)?$/)
      if (slugMatch) tempCelsius = parseInt(slugMatch[1])
    }

    if (tempCelsius === null) continue

    // ── Precio YES ─────────────────────────────────────────────────────────
    // outcomePrices es un string JSON: "[\"0.39\", \"0.61\"]"
    // índice 0 = YES, índice 1 = NO
    let price = 0
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices
      price = parseFloat(prices?.[0] ?? '0')
      if (isNaN(price)) price = 0
    } catch { price = 0 }

    // ── Token ID ───────────────────────────────────────────────────────────
    // clobTokenIds es un string JSON: "[\"<yes_id>\", \"<no_id>\"]"
    let tokenId = ''
    try {
      const ids = typeof m.clobTokenIds === 'string'
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds
      tokenId = ids?.[0] ?? ''
    } catch { tokenId = '' }

    // ── Resolución ─────────────────────────────────────────────────────────
    const resolved    = m.closed === true
    const resolvedYes = resolved && parseFloat(m.resolvedPrice ?? 'NaN') === 1

    tokens.push({
      tempCelsius,
      label:       label || `${tempCelsius}°C`,
      price,
      tokenId,
      resolved,
      resolvedYes,
      slug: m.slug ?? '',
    })
  }

  return tokens.sort((a, b) => a.tempCelsius - b.tempCelsius)
}

// ─── formatDateForSlug ────────────────────────────────────────────────────────
// "2026-03-22" → "march-22-2026"

function formatDateForSlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}
