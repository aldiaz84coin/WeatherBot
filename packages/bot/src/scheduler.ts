// packages/bot/src/scheduler.ts
// ──────────────────────────────────────────────────────────────────────────────
// Orchestrator del bot Madrid Temp
//
// ┌──────────────┬──────────────────────────────────────────────────────────┐
// │  Hora (CET)  │  Job                                                     │
// ├──────────────┼──────────────────────────────────────────────────────────┤
// │  00:30       │ 🎯 Ciclo de apuesta (Martingala) con N aplicado          │
// │  08:00       │ 🔬 Análisis diario: pesos → sesgo N → propuesta tokens   │
// │  18:00       │ 🌡️  Predicción extra / comparativa                       │
// │  09-20 /1h   │ 📸 Snapshot de precios (ventana de mercado)              │
// │  21:30       │ 🔔 Settlement + Martingala + optimización pesos          │
// │  23:00       │ 🔁 Retry settlement (si el mercado tardó en resolver)    │
// │  cada 30s    │ ⚙️  Job runner (backtests + live-switch pendiente)       │
// └──────────────┴──────────────────────────────────────────────────────────┘
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import cron from 'node-cron'

import { runDailyPrediction } from './prediction/predict'
import { runDailySettlement  } from './prediction/settle'
import { runPriceSnapshot    } from './prediction/price-snapshot'
import { startJobRunner      } from './jobs/job-runner'

import { runBettingCycle          } from './betting/engine'
import { settleBettingCycle       } from './betting/settle-cycle'
import { runDailyAnalysis         } from './betting/daily-analysis'
import { checkAndExecuteLiveSwitch } from './betting/live-switch'
import { checkAndRetryBettingCycle  } from './betting/retry-cycle'
import { botLogger                  } from './betting/logger'

const TZ = 'Europe/Madrid'

// ─── Arranque ─────────────────────────────────────────────────────────────────

;(async () => {
  const mode = process.env.LIVE_TRADING === 'true' ? '🔴 LIVE' : '🟡 SIMULACIÓN'
  console.log('🤖 Madrid Temp Bot iniciado')
  console.log(`   Modo:         ${mode}`)
  console.log(`   Zona horaria: ${TZ}`)
  console.log(`   Fecha:        ${new Date().toLocaleString('es-ES', { timeZone: TZ })}`)

  await botLogger.log('success', 'startup', `Bot iniciado — modo: ${mode}`, {
    liveTrading: process.env.LIVE_TRADING === 'true',
    tz: TZ,
    nodeVersion: process.version,
  })

  // ── Verificar live-switch pendiente en startup ───────────────────────────
  // Cubre el caso en que el bot se reinicia justo después de activar live
  try {
    await checkAndExecuteLiveSwitch()
  } catch (err) {
    await botLogger.error('Error en live-switch check (startup)', err)
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// CRON 1 — 00:30 · CICLO DE APUESTA (Motor de apuestas + Martingala + N bias)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('30 0 * * *', async () => {
  console.log('\n🎯 [00:30] Ciclo de apuesta — motor Martingala (con N aplicado)')
  try {
    await runBettingCycle()
  } catch (err) {
    await botLogger.error('Fatal en runBettingCycle', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 2 — 08:00 · ANÁLISIS DIARIO
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('\n🔬 [08:00] Análisis diario — pesos + sesgo N')
  try {
    await runDailyAnalysis()
  } catch (err) {
    await botLogger.error('Fatal en runDailyAnalysis', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 3 — 18:00 · PREDICCIÓN EXTRA
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log('\n🌡️  [18:00] Predicción extra / comparativa')
  try {
    await runDailyPrediction()
  } catch (err) {
    await botLogger.error('Fatal en runDailyPrediction', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 4 — 09:00–20:00 cada hora · SNAPSHOTS DE PRECIO
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 9-20 * * *', async () => {
  console.log(`\n📸 [${new Date().toLocaleTimeString('es-ES', { timeZone: TZ })}] Snapshot de precios`)
  try {
    await runPriceSnapshot()
  } catch (err) {
    await botLogger.error('Fatal en runPriceSnapshot', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 5 — 21:30 · SETTLEMENT
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('30 21 * * *', async () => {
  console.log('\n🔔 [21:30] Settlement + Martingala')
  try {
    await runDailySettlement()
    await settleBettingCycle()
  } catch (err) {
    await botLogger.error('Fatal en settlement (21:30)', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 6 — 23:00 · RETRY SETTLEMENT
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 23 * * *', async () => {
  console.log('\n🔁 [23:00] Retry settlement')
  try {
    await runDailySettlement()
    await settleBettingCycle()
  } catch (err) {
    await botLogger.error('Fatal en settlement (23:00)', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 7 — cada 30 s · JOB RUNNER (backtests + live-switch)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  try {
    // Backtests solicitados desde el dashboard
    await startJobRunner()

    // Transición simulated → live solicitada desde el dashboard
    await checkAndExecuteLiveSwitch()

    // Retry ciclo de apuesta solicitado desde el dashboard
    await checkAndRetryBettingCycle()
  } catch (err) {
    await botLogger.error('Error en job runner (30 s)', err)
  }
})
