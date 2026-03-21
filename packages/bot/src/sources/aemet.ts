// src/sources/aemet.ts
// AEMET: Agencia Estatal de Meteorología (España)
// API key gratuita: https://opendata.aemet.es/centrodedescargas/altaUsuario
// Estación Madrid-Retiro: código 3195

import axios from 'axios'
import type { WeatherSource, DailyForecast, HistoricalTemp } from './index'

const MADRID_MUNICIPIO = '28079'     // código INE de Madrid capital
const MADRID_STATION   = '3195'      // estación Madrid-Retiro
const BASE_URL         = 'https://opendata.aemet.es/opendata/api'

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

    // AEMET devuelve temperaturas como array con periodos; coger el máximo
    const tmax = Array.isArray(day.temperatura)
      ? Math.max(...day.temperatura.map((t: any) => Number(t.value)).filter(Boolean))
      : Number(day.temperatura?.maxima ?? day.temperatura)

    return {
      date: targetDate,
      tmax,
      source: this.slug,
      fetchedAt: new Date().toISOString(),
    }
  }

  async getHistorical(date: string): Promise<HistoricalTemp> {
    // Datos climatológicos diarios de la estación Madrid-Retiro
    const metaRes = await axios.get(
      `${BASE_URL}/valores/climatologicos/diarios/datos/fechaini/${date}T00:00:00UTC/fechafin/${date}T23:59:59UTC/estacion/${MADRID_STATION}`,
      { headers: { api_key: this.apiKey } }
    )

    const dataUrl = metaRes.data.datos
    const dataRes = await axios.get(dataUrl)
    const record = dataRes.data[0]

    // AEMET usa comas como decimal en los datos históricos
    const tmax = parseFloat(record.tmax.replace(',', '.'))
    return { date, tmax, source: this.slug }
  }
}
