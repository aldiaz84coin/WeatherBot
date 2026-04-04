// packages/bot/src/betting/bias-optimizer.ts
// ──────────────────────────────────────────────────────────────────────────────
// Lectura del sesgo N del ensemble desde bot_config.
//
// El sesgo N se gestiona EXCLUSIVAMENTE desde el AI Optimizer del dashboard:
//   dashboard → /api/ai-optimizer/apply-bias → bot_config[prediction_bias_n]
//
// El bot solo lo LEE a través de getCurrentBias():
//   engine.ts, daily-analysis.ts, live-switch.ts → getCurrentBias()
//
// NO hay escritura de N desde el bot.
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from '../db/supabase'

const CONFIG_KEY_N = 'prediction_bias_n'

// ─── Lectura del N actual (único uso permitido desde el bot) ──────────────────

export async function getCurrentBias(): Promise<number> {
  const { data } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', CONFIG_KEY_N)
    .maybeSingle()

  if (!data) return 0
  const val = typeof data.value === 'number' ? data.value : Number(data.value)
  return isNaN(val) ? 0 : val
}
