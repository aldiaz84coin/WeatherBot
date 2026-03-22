// src/prediction/price-snapshot.ts
// Job de snapshots de precio durante la ventana de mercado
// Corre cada hora (09:00–20:00) para registrar la evolución de precios
// de los tokens abiertos del día.
//
// Esto permite:
//   - Analizar cómo evolucionó el precio vs la predicción
//   - Calcular precio medio ponderado en el tiempo (TWAP)
//   - Visualizar en el dashboard la curva de precio intraday

import 'dotenv/config'
import { format } from 'date-fns'
import { supabase } from '../db/supabase'
import { MarketDiscovery } from '../polymarket/market-discovery'

export async function runPriceSnapshot() {
  const today = format(new Date(), 'yyyy-MM-dd')

  // Buscar predicciones activas (no liquidadas) para hoy
  const { data: predictions } = await supabase
    .from('predictions')
    .select(`
      id,
      target_date,
      token_a,
      token_b,
      trades ( slug, token_temp, position )
    `)
    .eq('target_date', today)
    .eq('settled', false)

  if (!predictions || predictions.length === 0) {
    console.log(`[Snapshot] Sin predicciones activas para ${today}`)
    return
  }

  // Obtener precios actuales del mercado
  const discovery = new MarketDiscovery()
  const markets   = await discovery.getMarketsForDate(today)

  if (!markets.available) {
    console.log(`[Snapshot] Mercado ${today} no disponible`)
    return
  }

  const now = new Date().toISOString()
  let count = 0

  for (const pred of predictions) {
    const trades: any[] = pred.trades ?? []

    for (const trade of trades) {
      const token = markets.tokens.find(
        (t: any) => t.tempCelsius === trade.token_temp
      )
      if (!token) continue

      await supabase.from('simulation_snapshots').insert({
        prediction_id:  pred.id,
        target_date:    today,
        slug:           trade.slug,
        token_temp:     trade.token_temp,
        price_snapshot: token.price,
        snapshot_at:    now,
      })
      count++
    }
  }

  console.log(`[Snapshot] ${count} snapshots guardados para ${today} @ ${now}`)
}

if (require.main === module) {
  runPriceSnapshot().catch(console.error)
}
