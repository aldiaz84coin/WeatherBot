// src/polymarket/slugs.ts
// Generador de slugs para los mercados diarios de temperatura en Madrid
//
// Formato confirmado (igual que el dashboard):
//   Evento del día: highest-temperature-in-madrid-on-march-27-2026
//
// El bot NO construye slugs de tokens individuales para buscarlos directamente.
// En su lugar usa el day slug con /events y extrae los sub-mercados del resultado,
// igual que hace el dashboard en /api/markets.

import { format } from 'date-fns'

// Slug del evento del día (sin temperatura específica)
// Ejemplo: "highest-temperature-in-madrid-on-march-27-2026"
export function buildDaySlug(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date
  return `highest-temperature-in-madrid-on-${format(d, 'MMMM-d-yyyy').toLowerCase()}`
}

// Parsea la fecha del slug para verificación
export function parseDateFromSlug(slug: string): string | null {
  const match = slug.match(/on-(\w+)-(\d+)-(\d{4})/)
  if (!match) return null
  const [, month, day, year] = match
  try {
    const d = new Date(`${month} ${day} ${year}`)
    return format(d, 'yyyy-MM-dd')
  } catch {
    return null
  }
}
