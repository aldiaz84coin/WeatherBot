// packages/bot/src/betting/retry-cycle.ts
// Detecta el flag pending_betting_retry en bot_config y relanza runBettingCycle().
// Llamado desde el scheduler cada 30 s, igual que checkAndExecuteLiveSwitch().

import { supabase }        from '../db/supabase'
import { getConfigValue, setConfigValue } from './config'
import { runBettingCycle } from './engine'
import { BotEventLogger }  from './logger'

const logger = new BotEventLogger('RETRY-CYCLE')

export async function checkAndRetryBettingCycle(): Promise<void> {
  const pending = await getConfigValue<boolean>('pending_betting_retry')
  if (!pending) return

  await logger.log('info', 'info', '🔁 Flag pending_betting_retry detectado — relanzando ciclo de apuesta…')

  try {
    await runBettingCycle()
  } catch (err) {
    await logger.error('Error durante el retry del ciclo de apuesta', err)
  } finally {
    // Limpiar flag siempre, incluso si hubo error
    await setConfigValue('pending_betting_retry', false)
    await logger.log('info', 'info', '🏁 Flag pending_betting_retry limpiado')
  }
}
