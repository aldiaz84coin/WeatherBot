// src/training/validator.ts
// ⭐ Validación del criterio del 90%
//
// Aplica validación cruzada temporal: entrena en los primeros 275 días
// y valida en los últimos 90 días (out-of-sample).
// El bot solo puede activarse si supera el 90% en AMBAS ventanas.

import type { BacktestResult } from './backtest'

const TARGET_HIT_RATE = 0.90
const VALIDATION_WINDOW_DAYS = 90   // días reservados para validación OOS

export interface ValidationReport {
  trainHitRate: number
  validationHitRate: number          // ⭐ el que importa: OOS
  passed: boolean                    // true solo si validación >= 90%
  trainDays: number
  validationDays: number
  failReason?: string
}

export function validateResult(result: BacktestResult): ValidationReport {
  const days = result.dayResults

  if (days.length < VALIDATION_WINDOW_DAYS + 30) {
    return {
      trainHitRate: result.hitRate,
      validationHitRate: result.hitRate,
      passed: false,
      trainDays: days.length,
      validationDays: 0,
      failReason: `Insuficientes datos (${days.length} días, mínimo ${VALIDATION_WINDOW_DAYS + 30})`,
    }
  }

  // Dividir en train y validación (los últimos 90 días = OOS)
  const trainDays = days.slice(0, days.length - VALIDATION_WINDOW_DAYS)
  const valDays   = days.slice(days.length - VALIDATION_WINDOW_DAYS)

  const trainHits = trainDays.filter(d => d.hit).length
  const valHits   = valDays.filter(d => d.hit).length

  const trainHitRate = trainHits / trainDays.length
  const validationHitRate = valHits / valDays.length

  const passed = validationHitRate >= TARGET_HIT_RATE

  console.log('\n📊 Validación cruzada temporal:')
  console.log(`   Train    (${trainDays.length} días):      ${(trainHitRate * 100).toFixed(1)}%`)
  console.log(`   Validación OOS (${valDays.length} días): ${(validationHitRate * 100).toFixed(1)}%  ${passed ? '✅' : '❌'}`)
  console.log(`   Objetivo: ≥ ${TARGET_HIT_RATE * 100}%`)

  return {
    trainHitRate,
    validationHitRate,
    passed,
    trainDays: trainDays.length,
    validationDays: valDays.length,
    failReason: passed
      ? undefined
      : `Hit rate OOS ${(validationHitRate * 100).toFixed(1)}% < objetivo ${TARGET_HIT_RATE * 100}%`,
  }
}

// Resumen legible para guardar en Supabase o mostrar en el dashboard
export function summaryText(report: ValidationReport): string {
  if (report.passed) {
    return `✅ Validación superada — OOS ${(report.validationHitRate * 100).toFixed(1)}% ≥ 90%`
  }
  return `❌ ${report.failReason}`
}
