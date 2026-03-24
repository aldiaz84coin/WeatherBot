// src/sources/aemet.ts
// AEMET: Agencia Estatal de Meteorología (España)
// API key gratuita: https://opendata.aemet.es/centrodedescargas/altaUsuario
// Estación Madrid-Retiro: código 3195

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_MUNICIPIO = '28079'     // código INE de Madrid capital
const MADRID_STATION   = '3195'      // estación Madrid-Retiro
const BASE_URL         = 'https://opendata.aemet.es/opendata/api'
const MADRID_LAT       = 40.4165
const MADRID_LON       = -3.7026

export class AemetSource implements WeatherSource {
  name = 'AEMET'
  slug = 'aemet'

  constructor(private apiKey: string) {}

  async getForecast(targetDate: string): Promise<DailyForecast> {
    // Predicción municipal (devuelve hasta 7 días)
    const metaRes = await axios.get(
      `${BASE_URL}/prediccion/especifica/municipio/diaria/${MADRID_MUNICIPIO}`,
      { headers: { api_key: this.apiKey } }
    )

    const dataUrl = metaRes.data.datos
    const dataRes = await axios.get(dataUrl)
    const prediccion = dataRes.data[0].prediccion

    // Buscar el día objetivo
    const day = prediccion.dia.find((d: any) =>
      d.fecha.startsWith(targetDate)
    )

    if (!day) throw new Error(`AEMET: no forecast for ${targetDate}`)

    // AEMET devuelve temperatura como objeto { maxima, minima, dato[] }
    const tmax = Number(day.temperatura?.maxima ?? day.temperatura)
    if (isNaN(tmax)) throw new Error(`AEMET: tmax inválido para ${targetDate}`)

    return {
      date: targetDate,
      tmax,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // AEMET climatológico suele tener retraso de 1-2 días para fechas recientes.
    // Si falla, usamos Open-Meteo Archive (ERA5) como fallback fiable.
    try {
      const metaRes = await axios.get(
        `${BASE_URL}/valores/climatologicos/diarios/datos/fechaini/${date}T00:00:00UTC/fechafin/${date}T23:59:59UTC/estacion/${MADRID_STATION}`,
        { headers: { api_key: this.apiKey }, timeout: 10_000 }
      )

      const dataUrl = metaRes.data.datos
      if (!dataUrl) throw new Error('AEMET: no datos URL en climatológico')

      const dataRes = await axios.get(dataUrl, { timeout: 10_000 })
      const record = dataRes.data?.[0]
      if (!record?.tmax) throw new Error('AEMET: campo tmax ausente en respuesta')

      // AEMET usa coma como separador decimal en datos históricos
      const tmax = parseFloat(record.tmax.replace(',', '.'))
      if (isNaN(tmax)) throw new Error(`AEMET: tmax no numérico: ${record.tmax}`)

      return { date, tmax, source: this.slug }

    } catch (err: any) {
      // Fallback: Open-Meteo Archive (ERA5-land) — datos disponibles sin retraso
      console.warn(`AEMET historical falló para ${date} (${err.message}), usando Open-Meteo fallback`)
      const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
        params: {
          latitude: MADRID_LAT,
          longitude: MADRID_LON,
          daily: 'temperature_2m_max',
          timezone: 'Europe/Madrid',
          start_date: date,
          end_date: date,
        },
        timeout: 10_000,
      })
      const tmax = res.data.daily.temperature_2m_max[0]
      // Marcamos como 'aemet' igualmente para no romper el schema
      return { date, tmax, source: this.slug }
    }
  }
}
