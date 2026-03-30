// packages/dashboard/types/ai-optimizer.ts
// Tipo compartido entre el API route y el componente cliente.
// Separado para evitar imports desde app/api/ en componentes 'use client'.

export interface SourceStats {
  mae:   number
  rmse:  number
  count: number
  bias:  number
}

export interface AIOptimizerResult {
  generatedAt:     string
  cyclesAnalyzed:  number
  hitRate:         number

  weightRecommendations: {
    weights:        Record<string, number>
    sourceStats:    Record<string, SourceStats>
    rationale:      string
    expectedMAE:    number
    improvedVsPrev: number | null
  }

  bettingRecommendations: {
    optimalBias:      number
    proposedTokenA:   number | null
    proposedTokenB:   number | null
    expectedHitRate:  number
    biasDistribution: Array<{ bias: number; hitRate: number; count: number }>
    rationale:        string
  }

  insights:  string[]
  warnings:  string[]
}
