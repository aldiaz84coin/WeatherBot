// app/api/debug-polymarket/route.ts  —  v2
// GET /api/debug-polymarket?date=2026-03-22

import { NextRequest, NextResponse } from 'next/server'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date') ?? '2026-03-22'

  const dateForSlug = formatDateForSlug(date)
  const daySlug     = `highest-temperature-in-madrid-on-${dateForSlug}`

  const report: Record<string, any> = { date, daySlug, tests: {} }

  // ── Test 1: listar todos los slugs del evento ─────────────────────────────
  let marketSlugs: string[] = []
  try {
    const res = await fetch(
      `${GAMMA_BASE}/events?slug=${encodeURIComponent(daySlug)}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    const events = await res.json()
    const markets: any[] = (events[0]?.markets ?? [])
    marketSlugs = markets.map((m: any) => m.slug).filter(Boolean)

    report.tests.all_market_slugs = {
      count: marketSlugs.length,
      slugs: marketSlugs,
    }

    // Muestra todas las keys y el objeto completo del primer market del evento
    if (markets.length > 0) {
      report.tests.event_market_keys   = Object.keys(markets[0])
      report.tests.event_market_sample = markets[0]
    }
  } catch (e: any) {
    report.tests.all_market_slugs = { error: e.message }
  }

  // ── Test 2: fetch individual del primer market slug ───────────────────────
  if (marketSlugs.length > 0) {
    try {
      const res2 = await fetch(
        `${GAMMA_BASE}/markets?slug=${encodeURIComponent(marketSlugs[0])}`,
        { signal: AbortSignal.timeout(8_000) }
      )
      const data2 = await res2.json()
      report.tests.individual_market_first = {
        slug:       marketSlugs[0],
        status:     res2.status,
        fullObject: Array.isArray(data2) && data2.length > 0 ? data2[0] : data2,
      }
    } catch (e: any) {
      report.tests.individual_market_first = { error: e.message }
    }
  }

  // ── Test 3: fetch del último market slug ──────────────────────────────────
  if (marketSlugs.length > 1) {
    const lastSlug = marketSlugs[marketSlugs.length - 1]
    try {
      const res3 = await fetch(
        `${GAMMA_BASE}/markets?slug=${encodeURIComponent(lastSlug)}`,
        { signal: AbortSignal.timeout(8_000) }
      )
      const data3 = await res3.json()
      report.tests.individual_market_last = {
        slug:       lastSlug,
        fullObject: Array.isArray(data3) && data3.length > 0 ? data3[0] : data3,
      }
    } catch (e: any) {
      report.tests.individual_market_last = { error: e.message }
    }
  }

  return NextResponse.json(report, { status: 200 })
}

function formatDateForSlug(date: string): string {
  const d = new Date(date + 'T12:00:00')
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december',
  ]
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`
}
