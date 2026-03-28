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
// │  cada 30s    │ ⚙️  Job runner (backtests pedidos desde el dashboard)    │
// └──────────────┴──────────────────────────────────────────────────────────┘
// ──────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import cron from 'node-cron'

import { runDailyPrediction } from './prediction/predict'
import { runDailySettlement  } from './prediction/settle'
import { runPriceSnapshot    } from './prediction/price-snapshot'
import { startJobRunner      } from './jobs/job-runner'

import { runBettingCycle    } from './betting/engine'
import { settleBettingCycle } from './betting/settle-cycle'
import { runDailyAnalysis   } from './betting/daily-analysis'   // ← NUEVO
import { botLogger          } from './betting/logger'

const TZ = 'Europe/Madrid'

// ─── Arranque ─────────────────────────────────────────────────────────────────

;(async () => {
  const mode = process.env.LIVE_TRADING === 'true' ? '🔴 LIVE' : '🟡 SIMULACIÓN'
  console.log('🤖 Madrid Temp Bot iniciado')
  console.log(`   Modo:        ${mode}`)
  console.log(`   Zona horaria: ${TZ}`)
  console.log(`   Fecha:        ${new Date().toLocaleString('es-ES', { timeZone: TZ })}`)

  await botLogger.log('success', 'startup', `Bot iniciado — modo: ${mode}`, {
    liveTrading: process.env.LIVE_TRADING === 'true',
    tz: TZ,
    nodeVersion: process.version,
  })
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
//
// Flujo:
//   1. Reoptimiza pesos de fuentes (MAE inverso, ventana 30 días)
//   2. Calcula sesgo N = mean(actual - ensemble) y lo persiste en bot_config
//   3. Genera forecast ensemble para mañana con pesos recién optimizados
//   4. Aplica corrección: ensemble_ajustado = ensemble + N
//   5. Propone: Token 1 = ceil(ensemble_ajustado)
//               Token 2 = ceil(ensemble_ajustado) + 1
//   6. Loguea propuesta completa con delta N vs ciclo anterior
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('\n🔬 [08:00] Análisis diario — pesos + sesgo N + propuesta tokens')
  try {
    await runDailyAnalysis()
  } catch (err) {
    await botLogger.error('Fatal en runDailyAnalysis', err)
    console.error(err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 3 — 18:00 · PREDICCIÓN EXTRA / COMPARATIVA
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  console.log('\n🌡️  [18:00] Predicción diaria (comparativa)')
  try {
    await runDailyPrediction()
  } catch (err) {
    await botLogger.error('Fatal en runDailyPrediction', err)
    console.error(err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 4 — cada hora de 09:00 a 20:00 · SNAPSHOT DE PRECIOS
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 9-20 * * *', async () => {
  const now = new Date().toLocaleTimeString('es-ES', { timeZone: TZ })
  console.log(`\n📸 [${now}] Snapshot de precios`)
  try {
    await runPriceSnapshot()
  } catch (err) {
    console.error('Error en price snapshot:', err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 5 — 21:30 · SETTLEMENT (resultado real + Martingala + pesos)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('30 21 * * *', async () => {
  console.log('\n🔔 [21:30] Settlement + Martingala + optimización pesos')
  try {
    await settleBettingCycle()
    await runDailySettlement()
  } catch (err) {
    await botLogger.error('Fatal en settlement', err)
    console.error(err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// CRON 6 — 23:00 · RETRY SETTLEMENT
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 23 * * *', async () => {
  console.log('\n🔁 [23:00] Retry settlement')
  try {
    await settleBettingCycle()
    await runDailySettlement()
  } catch (err) {
    await botLogger.error('Fatal en retry settlement', err)
    console.error(err)
  }
}, { timezone: TZ })

// ─────────────────────────────────────────────────────────────────────────────
// JOB RUNNER — cada 30s · Backtest jobs pedidos desde el dashboard
// ─────────────────────────────────────────────────────────────────────────────
startJobRunner()

console.log('⏰ Crons registrados. Bot en espera…\n')
