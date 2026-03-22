// src/scheduler.ts
// Orchestrator del bot Madrid Temp
//
// ┌─────────────────────────────────────────────────────────┐
// │  Cron jobs (Europe/Madrid)                              │
// ├──────────────┬──────────────────────────────────────────┤
// │  18:00       │ Predicción N+1 (pesos óptimos + 2 tokens)│
// │  09-20/1h    │ Snapshot de precios (ventana de mercado) │
// │  21:30       │ Settlement (resultado real + P&L)        │
// │  23:00       │ Retry settlement (si mercado tardó)      │
// │  cada 30s    │ Job runner (backtests pedidos dashboard) │
// └──────────────┴──────────────────────────────────────────┘

import 'dotenv/config'
import cron from 'node-cron'
import { runDailyPrediction } from './prediction/predict'
import { runDailySettlement  } from './prediction/settle'
import { runPriceSnapshot    } from './prediction/price-snapshot'
import { startJobRunner      } from './jobs/job-runner'

const TZ = 'Europe/Madrid'

console.log('🤖 Madrid Temp Bot iniciado')
console.log(`   Modo:        ${process.env.LIVE_TRADING === 'true' ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)
console.log('   Predicción:  18:00 Europe/Madrid')
console.log('   Snapshots:   cada hora 09-20h')
console.log('   Settlement:  21:30 Europe/Madrid')
console.log('   Retry:       23:00 Europe/Madrid')
console.log('   Job runner:  activo (backtest jobs cada 30s)\n')

// ── Predicción diaria — 18:00 ─────────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] 🔔 Ejecutando predicción diaria...`)
  try {
    await runDailyPrediction()
  } catch (err) {
    console.error('❌ Error en predicción diaria:', err)
  }
}, { scheduled: true, timezone: TZ })

// ── Snapshots de precio — cada hora de 09:00 a 20:00 ─────────────────────────
// "0 9-20 * * *" = minuto 0, horas 9..20
cron.schedule('0 9-20 * * *', async () => {
  try {
    await runPriceSnapshot()
  } catch (err) {
    console.error('❌ Error en snapshot:', err)
  }
}, { scheduled: true, timezone: TZ })

// ── Settlement — 21:30 ────────────────────────────────────────────────────────
cron.schedule('30 21 * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] 🔔 Settlement diario...`)
  try {
    await runDailySettlement()
  } catch (err) {
    console.error('❌ Error en settlement:', err)
  }
}, { scheduled: true, timezone: TZ })

// ── Retry settlement — 23:00 (por si el mercado resolvió tarde) ───────────────
cron.schedule('0 23 * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] 🔄 Retry settlement...`)
  try {
    await runDailySettlement()
  } catch (err) {
    console.error('❌ Error en retry settlement:', err)
  }
}, { scheduled: true, timezone: TZ })

// ── Job runner (backtest desde dashboard) — cada 30s ─────────────────────────
startJobRunner(30_000)

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('🛑 Bot detenido (SIGTERM)')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('🛑 Bot detenido (SIGINT)')
  process.exit(0)
})
