// app/api/debug-polymarket/route.ts
// Ruta temporal de diagnóstico — muestra exactamente qué devuelve la Gamma API
// BORRAR después de diagnosticar
// Uso: GET /api/debug-polymarket?date=2026-03-23

import { NextRequest, NextResponse } from 'next/server'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date') ?? '2026-03-22'

  const dateForSlug = formatDateForSlug(date)
  const daySlug = `highest-temperature-in-madrid-on-${dateForSlug}`

  const report: Record<string, any> = {
    date,
    dateForSlug,
    daySlug,
    tests: {},
  }

  // ── Test 1: /events?slug= ──────────────────────────────────────────────────
  try {
    const url1 = `${GAMMA_BASE}/events?slug=${encodeURIComponent(daySlug)}`
    report.tests.events_slug = { url: url1 }
    const res1 = await fetch(url1, { signal: AbortSignal.timeout(10_000) })
    report.tests.events_slug.status = res1.status
    report.tests.events_slug.ok     = res1.ok
    const body1 = await res1.text()
    report.tests.events_slug.bodyLength = body1.length
    try {
      const parsed = JSON.parse(body1)
      report.tests.events_slug.isArray     = Array.isArray(parsed)
      report.tests.events_slug.length      = Array.isArray(parsed) ? parsed.length : null
      if (Array.isArray(parsed) && parsed.length > 0) {
        const ev = parsed[0]
        report.tests.events_slug.eventKeys      = Object.keys(ev)
        report.tests.events_slug.marketsCount   = (ev.markets || []).length
        if (ev.markets?.length > 0) {
          const m0 = ev.markets[0]
          report.tests.events_slug.firstMarket  = {
            slug:       m0.slug,
            tokensType: typeof m0.tokens,
            tokensRaw:  m0.tokens,
          }
        }
      }
    } catch {
      report.tests.events_slug.parseError = 'no es JSON'
      report.tests.events_slug.bodyPreview = body1.slice(0, 500)
    }
  } catch (e: any) {
    report.tests.events_slug = { error: e.message }
  }

  // ── Test 2: /markets?slug= con slug del day ────────────────────────────────
  try {
    const url2 = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(daySlug)}`
    report.tests.markets_dayslug = { url: url2 }
    const res2 = await fetch(url2, { signal: AbortSignal.timeout(8_000) })
    report.tests.markets_dayslug.status = res2.status
    const body2 = await res2.text()
    const parsed2 = JSON.parse(body2)
    report.tests.markets_dayslug.isArray  = Array.isArray(parsed2)
    report.tests.markets_dayslug.length   = Array.isArray(parsed2) ? parsed2.length : null
    if (Array.isArray(parsed2) && parsed2.length > 0) {
      const m = parsed2[0]
      report.tests.markets_dayslug.firstMarket = {
        slug:           m.slug,
        question:       m.question,
        active:         m.active,
        closed:         m.closed,
        resolved:       m.resolved,
        tokensType:     typeof m.tokens,
        tokensIsArray:  Array.isArray(m.tokens),
        tokensLength:   Array.isArray(m.tokens) ? m.tokens.length
                        : typeof m.tokens === 'string' ? JSON.parse(m.tokens).length
                        : null,
        tokensRaw:      m.tokens,
        resolvedPrice:  m.resolvedPrice,
      }
    }
  } catch (e: any) {
    report.tests.markets_dayslug = { error: e.message }
  }

  // ── Test 3: un token concreto de temperatura ───────────────────────────────
  const tempSlug = `highest-temperature-in-madrid-18c-on-${dateForSlug}`
  try {
    const url3 = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(tempSlug)}`
    report.tests.token_slug_18c = { url: url3 }
    const res3 = await fetch(url3, { signal: AbortSignal.timeout(8_000) })
    report.tests.token_slug_18c.status = res3.status
    const body3 = await res3.text()
    const parsed3 = JSON.parse(body3)
    report.tests.token_slug_18c.isArray = Array.isArray(parsed3)
    report.tests.token_slug_18c.length  = Array.isArray(parsed3) ? parsed3.length : null
    if (Array.isArray(parsed3) && parsed3.length > 0) {
      const m = parsed3[0]
      report.tests.token_slug_18c.market = {
        slug:          m.slug,
        tokensType:    typeof m.tokens,
        tokensRaw:     m.tokens,
        resolvedPrice: m.resolvedPrice,
      }
    }
  } catch (e: any) {
    report.tests.token_slug_18c = { error: e.message }
  }

  // ── Test 4: /events con slug de ayer (debería tener datos resueltos) ────────
  const yesterday = offsetDate(date, -1)
  const yesterdaySlug = `highest-temperature-in-madrid-on-${formatDateForSlug(yesterday)}`
  try {
    const url4 = `${GAMMA_BASE}/events?slug=${encodeURIComponent(yesterdaySlug)}`
    report.tests.events_yesterday = { url: url4 }
    const res4 = await fetch(url4, { signal: AbortSignal.timeout(10_000) })
    report.tests.events_yesterday.status = res4.status
    const body4 = await res4.text()
    const parsed4 = JSON.parse(body4)
    report.tests.events_yesterday.isArray    = Array.isArray(parsed4)
    report.tests.events_yesterday.length     = Array.isArray(parsed4) ? parsed4.length : null
    if (Array.isArray(parsed4) && parsed4.length > 0) {
      const ev = parsed4[0]
      report.tests.events_yesterday.marketsCount = (ev.markets || []).length
      if (ev.markets?.length > 0) {
        const m0 = ev.markets[0]
        report.tests.events_yesterday.firstMarket = {
          slug:          m0.slug,
          resolved:      m0.resolved,
          resolvedPrice: m0.resolvedPrice,
          tokensType:    typeof m0.tokens,
          tokensRaw:     m0.tokens,
        }
      }
    }
  } catch (e: any) {
    report.tests.events_yesterday = { error: e.message }
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

function offsetDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}
