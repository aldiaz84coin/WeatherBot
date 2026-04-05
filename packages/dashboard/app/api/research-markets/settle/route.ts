// packages/dashboard/app/api/research-markets/settle/route.ts
//
// POST /api/research-markets/settle
//
// Para cada research_predictions donde settled=false y target_date ya pasó
// (en la tz de la ciudad), descarga la verdad ERA5 de Open-Meteo Archive
// y calcula hit_token (a/b) o null (miss).
//
// ERA5 tiene ~5 días de delay: si no hay dato, se deja pending.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { CITIES, type CityKey, cityToday, fetchOpenMeteoArchive, fetchPolymarket } from '@/lib/research/cities'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // ── 1. Traer todas las predicciones pendientes ────────────────────────────
  const { data: pending, error: fetchErr } = await supabase
    .from('research_predictions')
    .select('id, city, target_date, token_a, token_b')
    .eq('settled', false)
    .order('target_date', { ascending: true })

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!pending?.length) return NextResponse.json({ ok: true, settled: 0, pending: 0, results: [] })

  // ── 2. Filtrar las que ya pasaron (según su tz) ───────────────────────────
  const todayByCity: Record<CityKey, string> = {
    london: cityToday(CITIES.london.tz),
    milan:  cityToday(CITIES.milan.tz),
    munich: cityToday(CITIES.munich.tz),
    moscow: cityToday(CITIES.moscow.tz),
  }

  const toSettle = pending.filter(p => p.target_date < todayByCity[p.city as CityKey])
  const stillFuture = pending.length - toSettle.length

  // ── 3. Para cada una, fetch ERA5 + actualizar Polymarket resolvido ────────
  const results: Array<{
    id: string; city: string; date: string;
    actual: number | null; hit: string | null; status: 'settled' | 'pending_era5' | 'error';
    error?: string
  }> = []

  for (const p of toSettle) {
    const city = CITIES[p.city as CityKey]
    try {
      const actual = await fetchOpenMeteoArchive(city, p.target_date)

      if (actual.tmax == null) {
        // ERA5 aún no disponible (~5 días delay) — dejar pending
        results.push({
          id: p.id, city: p.city, date: p.target_date,
          actual: null, hit: null, status: 'pending_era5', error: actual.err ?? undefined,
        })
        continue
      }

      const actualInt = Math.ceil(actual.tmax)
      let hitToken: 'a' | 'b' | null = null
      if (actualInt === p.token_a) hitToken = 'a'
      else if (actualInt === p.token_b) hitToken = 'b'

      // Re-check Polymarket por si ya se resolvió
      const poly = await fetchPolymarket(city.slug, p.target_date).catch(() => null)

      const { error: updErr } = await supabase
        .from('research_predictions')
        .update({
          actual_tmax: actual.tmax,
          actual_source: 'era5',
          settled: true,
          settled_at: new Date().toISOString(),
          hit_token: hitToken,
          polymarket_temp: poly?.temp ?? null,
          polymarket_price: poly?.price ?? null,
          polymarket_resolved: poly?.resolved ?? false,
        })
        .eq('id', p.id)

      if (updErr) {
        results.push({ id: p.id, city: p.city, date: p.target_date, actual: actual.tmax, hit: hitToken, status: 'error', error: updErr.message })
      } else {
        results.push({ id: p.id, city: p.city, date: p.target_date, actual: actual.tmax, hit: hitToken, status: 'settled' })
      }
    } catch (e: any) {
      results.push({
        id: p.id, city: p.city, date: p.target_date,
        actual: null, hit: null, status: 'error', error: e.message,
      })
    }
  }

  const settledCount = results.filter(r => r.status === 'settled').length
  const pendingEra5 = results.filter(r => r.status === 'pending_era5').length

  return NextResponse.json({
    ok: true,
    settled: settledCount,
    pending_era5: pendingEra5,
    still_future: stillFuture,
    errors: results.filter(r => r.status === 'error').length,
    results,
  })
}

export async function GET() {
  return NextResponse.json({ status: 'ok', endpoint: '/api/research-markets/settle' })
}
