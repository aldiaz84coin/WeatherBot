// packages/dashboard/app/api/research-markets/history/route.ts
//
// GET /api/research-markets/history?city=<city>&limit=60
//
// Devuelve predicciones persistidas de una ciudad + estadísticas agregadas
// (hit rate, MAE por fuente) desde las vistas.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const VALID_CITIES = ['london', 'milan', 'munich', 'moscow'] as const

export async function GET(req: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  const { searchParams } = new URL(req.url)
  const city = searchParams.get('city')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '60', 10) || 60, 200)

  if (!city || !VALID_CITIES.includes(city as any)) {
    return NextResponse.json({ error: 'city requerido: london|milan|munich|moscow' }, { status: 400 })
  }

  // ── Predicciones persistidas ─────────────────────────────────────────────
  const { data: rows, error: rowsErr } = await supabase
    .from('research_predictions')
    .select('*')
    .eq('city', city)
    .order('target_date', { ascending: false })
    .limit(limit)

  if (rowsErr) return NextResponse.json({ error: rowsErr.message }, { status: 500 })

  // ── Hit rate agregado ────────────────────────────────────────────────────
  const { data: hitRate } = await supabase
    .from('v_research_hit_rate')
    .select('*')
    .eq('city', city)
    .maybeSingle()

  // ── MAE por fuente ────────────────────────────────────────────────────────
  const { data: sourceMae } = await supabase
    .from('v_research_source_mae')
    .select('*')
    .eq('city', city)

  return NextResponse.json({
    city,
    rows: rows ?? [],
    hitRate: hitRate ?? null,
    sourceMae: sourceMae ?? [],
  })
}

// Hit rate de TODAS las ciudades (para la tabla resumen)
export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  const { data, error } = await supabase
    .from('v_research_hit_rate')
    .select('*')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ hitRates: data ?? [] })
}
