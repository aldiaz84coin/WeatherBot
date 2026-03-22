// packages/dashboard/app/api/historical/route.ts
//
// GET /api/historical
// Devuelve estadísticas y pesos óptimos calculados sobre TODOS los
// registros históricos acumulados en historical_temperature_data.
//
// A diferencia de la optimización en tiempo real (8 días),
// este endpoint usa el histórico completo almacenado en Supabase,
// que crece con cada ejecución de la comparativa.

import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Fuentes en el mismo orden que el resto del sistema
const SOURCES = [
  { key: 'open_meteo',      maeCol: 'open_meteo_mae',      countCol: 'open_meteo_count'      },
  { key: 'aemet',           maeCol: 'aemet_mae',            countCol: 'aemet_count'            },
  { key: 'visual_crossing', maeCol: 'visual_crossing_mae',  countCol: 'visual_crossing_count'  },
  { key: 'weatherapi',      maeCol: 'weatherapi_mae',       countCol: 'weatherapi_count'       },
  { key: 'openweather',     maeCol: 'openweather_mae',      countCol: 'openweather_count'      },
  { key: 'tomorrow',        maeCol: 'tomorrow_mae',         countCol: 'tomorrow_count'         },
  { key: 'accuweather',     maeCol: 'accuweather_mae',      countCol: 'accuweather_count'      },
] as const

export async function GET() {
  try {
    // ── 1. MAE global de todas las fuentes ───────────────────────────────────
    const { data: stats, error: statsError } = await supabase
      .from('v_historical_source_mae')
      .select('*')
      .single()

    if (statsError) {
      // La vista puede no existir aún si no se aplicó la migración
      console.error('[historical] Error leyendo vista:', statsError.message)
      return NextResponse.json(
        { error: 'Vista v_historical_source_mae no disponible. Aplica la migración 004.' },
        { status: 503 }
      )
    }

    const totalDays = parseInt(stats?.total_resolved_days ?? '0')

    if (totalDays === 0) {
      return NextResponse.json({
        totalDays: 0,
        earliestDate: null,
        latestDate: null,
        maes: {},
        counts: {},
        optimalWeights: null,
        message: 'Sin datos históricos todavía. Abre la página de Comparativa para empezar a acumular registros.',
      })
    }

    // ── 2. Extraer MAE y count por fuente ────────────────────────────────────
    const maes:   Record<string, number> = {}
    const counts: Record<string, number> = {}

    for (const s of SOURCES) {
      const mae   = parseFloat(stats[s.maeCol]   ?? 'NaN')
      const count = parseInt(stats[s.countCol]   ?? '0')
      if (!isNaN(mae) && count > 0) {
        maes[s.key]   = mae
        counts[s.key] = count
      }
    }

    // ── 3. Calcular pesos óptimos por MAE inverso ────────────────────────────
    // Fuentes con MAE conocido reciben peso proporcional a 1/MAE.
    // Fuentes sin datos reciben peso 0.
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

    // ── 4. Últimos 10 registros para preview ─────────────────────────────────
    const { data: recent } = await supabase
      .from('historical_temperature_data')
      .select('date, polymarket_temp, open_meteo_tmax, aemet_tmax, visual_crossing_tmax, weatherapi_tmax, openweather_tmax, tomorrow_tmax, accuweather_tmax')
      .eq('polymarket_resolved', true)
      .order('date', { ascending: false })
      .limit(10)

    return NextResponse.json({
      totalDays,
      earliestDate: stats.earliest_date,
      latestDate:   stats.latest_date,
      maes,
      counts,
      optimalWeights,
      recent: recent ?? [],
    })
  } catch (err: any) {
    console.error('[historical] Error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
