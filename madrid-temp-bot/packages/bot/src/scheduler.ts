// src/scheduler.ts
// Cron diario — se ejecuta a las 18:00 hora de Madrid
// En Railway, usar TZ=Europe/Madrid en las variables de entorno

import 'dotenv/config'
import cron from 'node-cron'
import { runDailyPrediction } from './prediction/predict'

console.log('🤖 Madrid Temp Bot iniciado')
console.log(`   Modo: ${process.env.LIVE_TRADING === 'true' ? '🔴 LIVE' : '🟡 SIMULACIÓN'}`)
console.log('   Predicción diaria: 18:00 Europe/Madrid\n')

// Cada día a las 18:00 (hora de Madrid, TZ configurado en Railway)
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

// Mantener el proceso vivo
process.on('SIGTERM', () => {
  console.log('Bot detenido.')
  process.exit(0)
})
