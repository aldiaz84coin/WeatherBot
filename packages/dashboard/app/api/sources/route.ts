// app/api/sources/route.ts
// Actualiza la configuración de fuentes y parámetros del bot desde el dashboard.
// Escribe en las tablas bot_config y weather_sources de Supabase.
// El bot las lee en cada ejecución.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// GET: devuelve configuración actual
export async function GET() {
  const [sourcesRes, configRes] = await Promise.all([
    supabase.from('weather_sources').select('*').order('rmse_365d', { ascending: true }),
    supabase.from('bot_config').select('*'),
  ])

  return NextResponse.json({
    sources: sourcesRes.data ?? [],
    config: Object.fromEntries(
      (configRes.data ?? []).map(r => [r.key, { value: r.value, description: r.description }])
    ),
  })
}

// PATCH: actualiza configuración
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()

    const updates: Promise<any>[] = []

    // Actualizar fuentes activas
    if (body.sources) {
      for (const source of body.sources) {
        if (source.slug && typeof source.active === 'boolean') {
          updates.push(
            supabase
              .from('weather_sources')
              .update({ active: source.active, updated_at: new Date().toISOString() })
              .eq('slug', source.slug)
              .then()
          )
        }
        if (source.slug && typeof source.weight === 'number') {
          updates.push(
            supabase
              .from('weather_sources')
              .update({ weight: source.weight, updated_at: new Date().toISOString() })
              .eq('slug', source.slug)
              .then()
          )
        }
      }
    }

    // Actualizar parámetros de configuración
    if (body.config) {
      for (const [key, value] of Object.entries(body.config)) {
        updates.push(
          supabase
            .from('bot_config')
            .update({ value, updated_at: new Date().toISOString() })
            .eq('key', key)
            .then()
        )
      }

      // Actualizar lista de fuentes activas en bot_config
      if (body.activeSources) {
        updates.push(
          supabase
            .from('bot_config')
            .upsert({
              key: 'active_sources',
              value: body.activeSources,
              description: 'Fuentes activas para el ensemble',
            })
            .then()
        )
      }
    }

    await Promise.all(updates)

    return NextResponse.json({ ok: true, updated: updates.length })
  } catch (err) {
    console.error('Error en PATCH /api/sources:', err)
    return NextResponse.json({ error: 'Error actualizando configuración' }, { status: 500 })
  }
}
