// packages/dashboard/app/api/historical/route.ts
//
// GET /api/historical
// Calcula MAE y pesos óptimos directamente desde historical_temperature_data,
// sin depender de la vista v_historical_source_mae (evita problemas de permisos).

import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const SOURCES = [
  { key: 'open_meteo',      col: 'open_meteo_tmax'      },
  { key: 'aemet',           col: 'aemet_tmax'            },
  { key: 'visual_crossing', col: 'visual_crossing_tmax'  },
  { key: 'weatherapi',      col: 'weatherapi_tmax'       },
  { key: 'openweather',     col: 'openweather_tmax'      },
  { key: 'tomorrow',        col: 'tomorrow_tmax'         },
  { key: 'accuweather',     col: 'accuweather_tmax'      },
] as const

export async function GET() {
  try {
    // ── 1. Traer todos los días resueltos ─────────────────────────────────────
    const { data: rows, error } = await supabase
      .from('historical_temperature_data')
      .select('date, polymarket_temp, open_meteo_tmax, aemet_tmax, visual_crossing_tmax, weatherapi_tmax, openweather_tmax, tomorrow_tmax, accuweather_tmax')
      .eq('polymarket_resolved', true)
      .order('date', { ascending: false })

    if (error) {
      console.error('[historical] Error leyendo tabla:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        totalDays: 0,
        earliestDate: null,
        latestDate: null,
        maes: {},
        counts: {},
        optimalWeights: null,
        recent: [],
        message: 'Sin datos históricos todavía. Abre la página de Comparativa y pulsa "Actualizar datos" para empezar a acumular registros.',
      })
    }

    // ── 2. Calcular MAE por fuente en JS (sin depender de la vista SQL) ───────
    const sumErrors: Record<string, number> = {}
    const counts:    Record<string, number> = {}

    for (const row of rows) {
      const ref = row.polymarket_temp
      if (ref === null || ref === undefined) continue

      for (const s of SOURCES) {
        const v = (row as any)[s.col]
        if (v === null || v === undefined) continue
        sumErrors[s.key] = (sumErrors[s.key] ?? 0) + Math.abs(v - ref)
        counts[s.key]    = (counts[s.key]    ?? 0) + 1
      }
    }

    const maes: Record<string, number> = {}
    for (const s of SOURCES) {
      if (counts[s.key] > 0) {
        maes[s.key] = parseFloat((sumErrors[s.key] / counts[s.key]).toFixed(3))
      }
    }

    // ── 3. Pesos óptimos por MAE inverso ──────────────────────────────────────
    const invertedMaes: Record<string, number> = {}
    let totalInv = 0
    for (const s of SOURCES) {
      const mae = maes[s.key]
      if (mae !== undefined && mae > 0) {
        invertedMaes[s.key] = 1 / mae
        totalInv += invertedMaes[s.key]
      } else {
        invertedMaes[s.key] = 0
      }
    }

    const optimalWeights: Record<string, number> = {}
    for (const s of SOURCES) {
      optimalWeights[s.key] = totalInv > 0
        ? parseFloat((invertedMaes[s.key] / totalInv).toFixed(4))
        : 0
    }

    // ── 4. Últimos 10 para preview ────────────────────────────────────────────
    const recent = rows.slice(0, 10)
    const dates  = rows.map((r: any) => r.date).filter(Boolean)

    return NextResponse.json({
      totalDays:    rows.length,
      earliestDate: dates[dates.length - 1] ?? null,
      latestDate:   dates[0] ?? null,
      maes,
      counts,
      optimalWeights,
      recent,
    })
  } catch (err: any) {
    console.error('[historical] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

