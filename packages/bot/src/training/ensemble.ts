// src/training/ensemble.ts
// Optimizador de pesos del ensemble
//
// ⭐ OBJETIVO: encontrar los pesos w1..w10 que maximizan el hit rate
// de la estrategia 3-tokens (pred±1°, coste < 0.80 USDC)
// hasta superar el 90% en los datos históricos.

import type { BacktestResult } from './backtest'
import { WeatherSourceManager } from '../sources'
import { runBacktest } from './backtest'

interface WeightVector {
  weights: Record<string, number>
  hitRate: number
}

// ─── Estrategia 1: ranking por RMSE individual ────────────────────────────────
// Asignar más peso a las fuentes con menor RMSE

export function weightsFromRmse(rmseBySource: Record<string, number>): Record<string, number> {
  // Invertir RMSE para que menor error → mayor peso
  const inverted: Record<string, number> = {}
  for (const [slug, rmse] of Object.entries(rmseBySource)) {
    inverted[slug] = rmse > 0 ? 1 / rmse : 0
  }

  const total = Object.values(inverted).reduce((a, b) => a + b, 0)
  const weights: Record<string, number> = {}
  for (const [slug, inv] of Object.entries(inverted)) {
    weights[slug] = inv / total
  }

  return weights
}

// ─── Estrategia 2: búsqueda por grid search simplificada ─────────────────────
// Probar combinaciones de pesos en pasos de 0.1 para las N mejores fuentes

export async function optimizeEnsemble(
  manager: WeatherSourceManager,
  baseResult: BacktestResult,
  maxIterations = 20
): Promise<WeightVector> {
  console.log('\n🔧 Iniciando optimización del ensemble...')

  // Empezar con pesos basados en RMSE
  let bestWeights = weightsFromRmse(baseResult.rmseBySource)
  let bestHitRate = baseResult.hitRate

  console.log(`   Pesos iniciales (por RMSE): hit rate base = ${(bestHitRate * 100).toFixed(1)}%`)

  if (bestHitRate >= 0.90) {
    console.log('   ✅ Ya supera el objetivo — no es necesario optimizar más')
    return { weights: bestWeights, hitRate: bestHitRate }
  }

  // Ordenar fuentes por RMSE (mejores primero)
  const rankedSources = Object.entries(baseResult.rmseBySource)
    .sort(([, a], [, b]) => a - b)
    .map(([slug]) => slug)

  // Intentar dar todo el peso a la mejor fuente
  for (const topSource of rankedSources.slice(0, 3)) {
    const singleSourceWeights: Record<string, number> = {}
    for (const slug of rankedSources) {
      singleSourceWeights[slug] = slug === topSource ? 1.0 : 0.0
    }
    manager.setWeights(singleSourceWeights)
    const result = await runBacktest(manager, 180)  // ventana más corta para velocidad

    if (result.hitRate > bestHitRate) {
      bestHitRate = result.hitRate
      bestWeights = singleSourceWeights
      console.log(`   Mejor: fuente ${topSource} sola → ${(bestHitRate * 100).toFixed(1)}%`)
    }

    if (bestHitRate >= 0.90) break
  }

  // Grid search: top-3 fuentes con distintas distribuciones
  if (bestHitRate < 0.90) {
    const top3 = rankedSources.slice(0, 3)
    const steps = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

    outer: for (const w1 of steps) {
      for (const w2 of steps) {
        const w3 = parseFloat((1 - w1 - w2).toFixed(2))
        if (w3 < 0 || w3 > 1) continue

        const trialWeights: Record<string, number> = {}
        for (const slug of rankedSources) {
          if (slug === top3[0]) trialWeights[slug] = w1
          else if (slug === top3[1]) trialWeights[slug] = w2
          else if (slug === top3[2]) trialWeights[slug] = w3
          else trialWeights[slug] = 0
        }

        manager.setWeights(trialWeights)
        const result = await runBacktest(manager, 180)

        if (result.hitRate > bestHitRate) {
          bestHitRate = result.hitRate
          bestWeights = trialWeights
          console.log(`   Mejor ensemble [${w1}/${w2}/${w3}] → ${(bestHitRate * 100).toFixed(1)}%`)
        }

        if (bestHitRate >= 0.90) break outer
      }
    }
  }

  console.log(`\n   Resultado final: ${(bestHitRate * 100).toFixed(1)}% ${bestHitRate >= 0.90 ? '✅' : '❌'}`)
  return { weights: bestWeights, hitRate: bestHitRate }
}
