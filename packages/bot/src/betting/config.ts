// packages/bot/src/betting/config.ts
// ──────────────────────────────────────────────────────────────────────────────
// Helpers para leer y escribir bot_config en Supabase.
// Toda la configuración del motor de apuestas vive en la BD
// para que pueda modificarse desde el dashboard sin redeploy.
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from '../db/supabase'

// ─── Lectura ──────────────────────────────────────────────────────────────────

export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const { data, error } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', key)
    .single()

  if (error || !data) return null
  return data.value as T
}

// ─── Escritura ────────────────────────────────────────────────────────────────

export async function setConfigValue(key: string, value: unknown): Promise<void> {
  const { error } = await supabase
    .from('bot_config')
    .update({
      value:      value,          // Supabase guarda jsonb → acepta any
      updated_at: new Date().toISOString(),
    })
    .eq('key', key)

  if (error) {
    throw new Error(`No se pudo actualizar bot_config[${key}]: ${error.message}`)
  }
}

// ─── Config del motor de apuestas ────────────────────────────────────────────

export interface StakeConfig {
  baseStake:          number   // stake base (USDC)
  maxStake:           number   // tope máximo (USDC)
  multiplier:         number   // multiplicador actual
  consecutiveLosses:  number   // racha de pérdidas
  currentStake:       number   // stake efectivo = min(base*mult, max)
  cappedAtMax:        boolean  // ¿el stake está en el tope?
  bettingMode:        'simulated' | 'live'
}

export async function getStakeConfig(): Promise<StakeConfig> {
  const [baseRaw, maxRaw, multRaw, lossesRaw, modeRaw] = await Promise.all([
    getConfigValue<number>('base_stake_usdc'),
    getConfigValue<number>('max_stake_usdc'),
    getConfigValue<number>('current_multiplier'),
    getConfigValue<number>('consecutive_losses'),
    getConfigValue<string>('betting_mode'),
  ])

  const base         = Number(baseRaw)   || 20
  const max          = Number(maxRaw)    || 160
  const mult         = Number(multRaw)   || 1
  const losses       = Number(lossesRaw) || 0
  const mode         = (modeRaw as string) === 'live' ? 'live' : 'simulated'

  const raw          = base * mult
  const current      = parseFloat(Math.min(raw, max).toFixed(4))
  const cappedAtMax  = raw >= max

  return {
    baseStake:         base,
    maxStake:          max,
    multiplier:        mult,
    consecutiveLosses: losses,
    currentStake:      current,
    cappedAtMax,
    bettingMode:       mode,
  }
}

// ─── Resetear stake (tras ganar) ─────────────────────────────────────────────

export async function resetStake(): Promise<void> {
  await Promise.all([
    setConfigValue('current_multiplier', 1),
    setConfigValue('consecutive_losses', 0),
  ])
}

// ─── Doblar stake (tras perder, Martingala) ───────────────────────────────────

export async function doubleStake(current: StakeConfig): Promise<StakeConfig> {
  const newMult    = current.multiplier * 2
  const newStake   = parseFloat(Math.min(current.baseStake * newMult, current.maxStake).toFixed(4))
  const effectMult = newStake / current.baseStake         // puede ser < newMult si topó

  await Promise.all([
    setConfigValue('current_multiplier', effectMult),
    setConfigValue('consecutive_losses', current.consecutiveLosses + 1),
  ])

  return {
    ...current,
    multiplier:         effectMult,
    consecutiveLosses:  current.consecutiveLosses + 1,
    currentStake:       newStake,
    cappedAtMax:        newStake >= current.maxStake,
  }
}
