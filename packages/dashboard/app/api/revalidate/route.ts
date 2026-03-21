// app/api/revalidate/route.ts
// Webhook que recibe notificaciones de Supabase y fuerza revalidación del dashboard
// Configurar en Supabase: Database Webhooks → URL: https://tu-app.vercel.app/api/revalidate

import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'

const WEBHOOK_SECRET = process.env.SUPABASE_WEBHOOK_SECRET ?? ''

export async function POST(req: NextRequest) {
  // Verificar secreto para evitar llamadas no autorizadas
  const authHeader = req.headers.get('authorization')
  if (WEBHOOK_SECRET && authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const table = body?.table as string | undefined

    // Revalidar las páginas según qué tabla cambió
    if (table === 'predictions' || table === 'trades') {
      revalidatePath('/')
      revalidatePath('/predictions')
    }

    if (table === 'results') {
      revalidatePath('/')
      revalidatePath('/predictions')
    }

    if (table === 'training_runs' || table === 'weather_sources') {
      revalidatePath('/')
      revalidatePath('/training')
    }

    // Fallback: revalidar todo
    if (!table) {
      revalidatePath('/', 'layout')
    }

    return NextResponse.json({ revalidated: true, table })
  } catch (err) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
}
