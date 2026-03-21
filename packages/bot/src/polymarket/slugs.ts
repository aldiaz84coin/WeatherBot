// src/polymarket/slugs.ts
// Generador de slugs para los mercados diarios de temperatura en Madrid
// Formato: highest-temperature-in-madrid-on-march-21-2026

import { format } from 'date-fns'

// Slug del mercado del día (sin temperatura específica)
export function buildDaySlug(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date
  return `highest-temperature-in-madrid-on-${format(d, 'MMMM-d-yyyy').toLowerCase()}`
}

// Slug de un token específico de temperatura
// Ejemplo: highest-temperature-in-madrid-36c-on-march-21-2026
export function buildTokenSlug(date: Date | string, tempCelsius: number): string {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date
  const tempRounded = Math.round(tempCelsius)
  return `highest-temperature-in-madrid-${tempRounded}c-on-${format(d, 'MMMM-d-yyyy').toLowerCase()}`
}

// Parsea la fecha del slug para verificación
export function parseDateFromSlug(slug: string): string | null {
  const match = slug.match(/on-(\w+)-(\d+)-(\d{4})$/)
  if (!match) return null
  const [, month, day, year] = match
  try {
    const d = new Date(`${month} ${day} ${year}`)
    return format(d, 'yyyy-MM-dd')
  } catch {
    return null
  }
}
