// src/scheduler.ts — ACTUALIZADO
// Incluye el job runner para procesar backtests pedidos desde el dashboard.

import 'dotenv/config'
import cron from 'node-cron'
import { runDailyPrediction } from './prediction/predict'
import { startJobRunner } from './jobs/job-runner'

console.log('🤖 Madrid Temp Bot iniciado')
console.log(`   Modo: ${process.env.LIVE_TRADING === 'true' ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)
console.log('   Predicción diaria: 18:00 Europe/Madrid')
console.log('   Job runner: activo (backtest jobs cada 30s)\n')

// ── Predicción diaria a las 18:00 ────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log(`\n[${new Date().toISOString()}] 🔔 Ejecutando predicción diaria...`)
  try {
    await runDailyPrediction()
  } catch (err) {
    console.error('Error en predicción diaria:', err)
  }
}, {
  scheduled: true,
  timezone: 'Europe/Madrid',
})

// ── Job runner: procesar backtests pedidos desde el dashboard ────────────────
startJobRunner(30_000) // Comprobar cada 30 segundos

// ── Mantener proceso vivo ─────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('Bot detenido.')
  process.exit(0)
})
