// packages/dashboard/app/api/ai-optimizer/route.ts
// ──────────────────────────────────────────────────────────────────────────────
// Endpoint del optimizador IA.
//
// POST /api/ai-optimizer
// Body: { mode: 'weights' | 'bias' | 'full', lookbackDays?: number }
//
// Flujo:
//   1. Leer historial liquidado de v_ai_training_data
//   2. Calcular estadísticas base (MAE por fuente, hit rate histórico, etc.)
//   3. Llamar a Claude con los datos y pedir recomendaciones estructuradas
//   4. Devolver JSON con las dos optimizaciones
//
// GET /api/ai-optimizer → devuelve los últimos resultados cacheados (bot_config)
// ──────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { AIOptimizerResult, SourceStats } from '../../../types/ai-optimizer'

export type { AIOptimizerResult }

export const dynamic = 'force-dynamic'

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface TrainingRow {
  cycle_id:                  string
  target_date:               string
  ensemble_temp:             number
  bias_applied:              number | null
  ensemble_adjusted:         number
  token_a_temp:              number
  token_b_temp:              number
  price_a:                   number | null
  price_b:                   number | null
  actual_temp:               number
  won:                       boolean
  pnl_usdc:                  number | null
  error_raw:                 number
  error_adj:                 number
  offset_miss:               number
  source_temps:              Record<string, number> | null
  weights_used:              Record<string, number> | null
  opt_weights_at_prediction: Record<string, number> | null
}

// ─── GET — devolver último resultado cacheado ─────────────────────────────────

export async function GET() {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    )
    const { data } = await supabase
      .from('bot_config')
      .select('value')
      .eq('key', 'ai_optimizer_last_result')
      .maybeSingle()

    if (!data) {
      return NextResponse.json({ cached: null }, { status: 200 })
    }

    return NextResponse.json({ cached: data.value }, { status: 200 })
  } catch (err: any) {
    console.error('[ai-optimizer GET] Error:', err)
    return NextResponse.json({ error: err.message ?? 'Error interno' }, { status: 500 })
  }
}

// ─── POST — ejecutar optimización ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    )

    const body = await req.json().catch(() => ({}))
    const mode         = (body.mode ?? 'full') as 'weights' | 'bias' | 'full'
    const lookbackDays = Math.min(Number(body.lookbackDays ?? 60), 120)

    // ── 1. Cargar historial desde la vista ──────────────────────────────────
    const { data: rows, error: dbErr } = await supabase
      .from('v_ai_training_data')
      .select('*')
      .limit(lookbackDays)

    if (dbErr) {
      return NextResponse.json({ error: `DB error: ${dbErr.message}` }, { status: 500 })
    }

    const training = (rows ?? []) as TrainingRow[]

    if (training.length < 5) {
      return NextResponse.json(
        { error: `Datos insuficientes: solo ${training.length} ciclos liquidados. Mínimo 5.` },
        { status: 422 },
      )
    }

    // ── 2. Calcular estadísticas base ───────────────────────────────────────
    const sourceStats = computeSourceStats(training)
    const hitRate     = training.filter(r => r.won).length / training.length
    const biasDistrib = computeBiasDistribution(training)

    // ── 3. Cargar pesos actuales desde weather_sources ──────────────────────
    const { data: currentSourcesData } = await supabase
      .from('weather_sources')
      .select('slug, weight, rmse_365d')
      .eq('active', true)

    const currentWeights: Record<string, number> = Object.fromEntries(
      (currentSourcesData ?? []).map(s => [s.slug, s.weight])
    )

    // ── 4. Ensemble de mañana (última predicción registrada) ─────────────────
    const { data: tomorrowPred } = await supabase
      .from('predictions')
      .select('ensemble_temp, target_date, source_temps')
      .order('target_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    // ── 5. Construir prompt para Claude ─────────────────────────────────────
    const systemPrompt = buildSystemPrompt()
    const userPrompt   = buildUserPrompt({
      mode,
      training,
      sourceStats,
      hitRate,
      biasDistrib,
      currentWeights,
      tomorrowEnsemble: tomorrowPred?.ensemble_temp ?? null,
      tomorrowDate:     tomorrowPred?.target_date   ?? null,
      tomorrowSources:  tomorrowPred?.source_temps  ?? null,
    })

    // ── 6. Llamar a Claude ───────────────────────────────────────────────────
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body:    JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text()
      return NextResponse.json({ error: `Claude API error: ${errText}` }, { status: 502 })
    }

    const claudeData = await claudeResponse.json()
    const rawText    = claudeData.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('') ?? ''

    // ── 7. Parsear respuesta JSON de Claude ──────────────────────────────────
    let aiOutput: any
    try {
      const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      aiOutput    = JSON.parse(clean)
    } catch {
      return NextResponse.json(
        { error: 'Claude devolvió respuesta no parseable', raw: rawText.slice(0, 500) },
        { status: 502 },
      )
    }

    // ── 8. Montar resultado final ────────────────────────────────────────────
    const result: AIOptimizerResult = {
      generatedAt:    new Date().toISOString(),
      cyclesAnalyzed: training.length,
      hitRate:        Math.round(hitRate * 1000) / 10,

      weightRecommendations: {
        weights:        normalizeWeights(aiOutput.weights ?? {}),
        sourceStats,
        rationale:      aiOutput.weightsRationale   ?? '',
        expectedMAE:    aiOutput.expectedMAE        ?? 0,
        improvedVsPrev: computeMAEImprovement(training, currentWeights, aiOutput.weights ?? {}),
      },

      bettingRecommendations: {
        optimalBias:     aiOutput.optimalBias        ?? 0,
        proposedTokenA:  aiOutput.proposedTokenA     ?? null,
        proposedTokenB:  aiOutput.proposedTokenB     ?? null,
        expectedHitRate: aiOutput.expectedHitRate    ?? 0,
        biasDistribution: biasDistrib,
        rationale:       aiOutput.bettingRationale  ?? '',
      },

      insights:  aiOutput.insights  ?? [],
      warnings:  aiOutput.warnings  ?? [],
    }

    // ── 9. Cachear resultado en bot_config ───────────────────────────────────
    await supabase
      .from('bot_config')
      .upsert(
        {
          key:         'ai_optimizer_last_result',
          value:       result as any,
          description: 'Último resultado del optimizador IA (pesos + bias)',
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'key' },
      )

    return NextResponse.json(result, { status: 200 })

  } catch (err: any) {
    console.error('[ai-optimizer] Error inesperado:', err)
    return NextResponse.json(
      { error: err.message ?? 'Error interno del servidor' },
      { status: 500 },
    )
  }
}

// ─── Helpers: estadísticas ────────────────────────────────────────────────────

function computeSourceStats(rows: TrainingRow[]): Record<string, SourceStats> {
  const acc: Record<string, { absErrors: number[]; errors: number[] }> = {}

  for (const row of rows) {
    if (!row.source_temps || !row.actual_temp) continue
    for (const [src, temp] of Object.entries(row.source_temps)) {
      if (temp == null) continue
      const err = temp - row.actual_temp
      if (!acc[src]) acc[src] = { absErrors: [], errors: [] }
      acc[src].absErrors.push(Math.abs(err))
      acc[src].errors.push(err)
    }
  }

  const stats: Record<string, SourceStats> = {}
  for (const [src, { absErrors, errors }] of Object.entries(acc)) {
    const n    = absErrors.length
    const mae  = absErrors.reduce((a, b) => a + b, 0) / n
    const rmse = Math.sqrt(errors.map(e => e * e).reduce((a, b) => a + b, 0) / n)
    const bias = errors.reduce((a, b) => a + b, 0) / n
    stats[src] = {
      mae:   Math.round(mae  * 1000) / 1000,
      rmse:  Math.round(rmse * 1000) / 1000,
      bias:  Math.round(bias * 1000) / 1000,
      count: n,
    }
  }
  return stats
}

function computeBiasDistribution(
  rows: TrainingRow[],
): Array<{ bias: number; hitRate: number; count: number }> {
  const candidates = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]

  return candidates.map(bias => {
    let wins = 0
    let count = 0
    for (const row of rows) {
      const adj    = row.ensemble_temp + bias
      const tokA   = Math.ceil(adj)
      const tokB   = tokA + 1
      const actual = Math.round(row.actual_temp)
      if (actual === tokA || actual === tokB) wins++
      count++
    }
    return {
      bias,
      hitRate: count > 0 ? Math.round((wins / count) * 1000) / 10 : 0,
      count,
    }
  })
}

function computeMAEImprovement(
  rows:         TrainingRow[],
  prevWeights:  Record<string, number>,
  newWeights:   Record<string, number>,
): number | null {
  if (!Object.keys(prevWeights).length || !Object.keys(newWeights).length) return null

  let prevErr = 0, newErr = 0, count = 0

  for (const row of rows) {
    if (!row.source_temps || !row.actual_temp) continue
    const sources = row.source_temps

    const ensemblePrev = weightedEnsemble(sources, prevWeights)
    const ensembleNew  = weightedEnsemble(sources, newWeights)
    if (ensemblePrev === null || ensembleNew === null) continue

    prevErr += Math.abs(ensemblePrev - row.actual_temp)
    newErr  += Math.abs(ensembleNew  - row.actual_temp)
    count++
  }

  if (!count) return null
  return Math.round(((prevErr - newErr) / count) * 1000) / 1000
}

function weightedEnsemble(
  sources: Record<string, number>,
  weights: Record<string, number>,
): number | null {
  let sum = 0, wsum = 0
  for (const [src, w] of Object.entries(weights)) {
    const t = sources[src]
    if (t == null || !w) continue
    sum  += t * w
    wsum += w
  }
  return wsum > 0 ? sum / wsum : null
}

function normalizeWeights(raw: Record<string, number>): Record<string, number> {
  const total = Object.values(raw).reduce((a, b) => a + b, 0)
  if (!total) return raw
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Math.round((v / total) * 1000) / 1000
  }
  return out
}

// ─── Helpers: prompts ─────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `Eres un analista cuantitativo especializado en optimización de modelos de predicción meteorológica y estrategias de apuestas en mercados de predicción.

Tu tarea es analizar datos históricos de un bot que apuesta en Polymarket sobre la temperatura máxima diaria en Madrid, y devolver recomendaciones de optimización en formato JSON estricto.

REGLAS DE RESPUESTA:
- Responde ÚNICAMENTE con un objeto JSON válido. Sin texto adicional, sin markdown, sin explicaciones fuera del JSON.
- Todos los números deben ser de tipo number (no string).
- Los pesos de fuentes deben sumar exactamente 1.0.
- El bias óptimo debe estar entre -3.0 y +3.0.

ESTRUCTURA JSON REQUERIDA:
{
  "weights": {
    "<slug_fuente>": <peso_float_0_a_1>,
    ...
  },
  "weightsRationale": "<explicación en español, máx 300 chars>",
  "expectedMAE": <MAE_esperado_con_nuevos_pesos_float>,
  "optimalBias": <bias_N_optimo_float>,
  "proposedTokenA": <temperatura_token_A_int_o_null>,
  "proposedTokenB": <temperatura_token_B_int_o_null>,
  "expectedHitRate": <hit_rate_esperado_0_a_100_float>,
  "bettingRationale": "<explicación en español, máx 300 chars>",
  "insights": ["<insight 1>", "<insight 2>", ...],
  "warnings": ["<warning 1>", ...]
}

NOTA: proposedTokenA y proposedTokenB solo se rellenan si hay datos del ensemble de mañana disponibles. Si no, devuelve null.`
}

function buildUserPrompt(params: {
  mode:             'weights' | 'bias' | 'full'
  training:         TrainingRow[]
  sourceStats:      Record<string, SourceStats>
  hitRate:          number
  biasDistrib:      Array<{ bias: number; hitRate: number; count: number }>
  currentWeights:   Record<string, number>
  tomorrowEnsemble: number | null
  tomorrowDate:     string | null
  tomorrowSources:  Record<string, number> | null
}): string {
  const {
    mode, training, sourceStats, hitRate,
    biasDistrib, currentWeights,
    tomorrowEnsemble, tomorrowDate, tomorrowSources,
  } = params

  const N = training.length

  const recentSample = training.slice(0, 10).map(r => ({
    date:      r.target_date,
    ensemble:  r.ensemble_temp,
    bias:      r.bias_applied ?? 0,
    actual:    r.actual_temp,
    tokenA:    r.token_a_temp,
    tokenB:    r.token_b_temp,
    won:       r.won,
    errorRaw:  r.error_raw,
    errorAdj:  r.error_adj,
    offsetMis: r.offset_miss,
  }))

  const avgErrorRaw  = training.reduce((s, r) => s + r.error_raw, 0) / N
  const avgErrorAdj  = training.reduce((s, r) => s + r.error_adj, 0) / N
  const avgOffMiss   = training.reduce((s, r) => s + r.offset_miss, 0) / N

  const biasTable = biasDistrib
    .map(b => `  bias=${b.bias >= 0 ? '+' : ''}${b.bias}: hitRate=${b.hitRate}% (${b.count} días)`)
    .join('\n')

  const sourceTable = Object.entries(sourceStats)
    .sort(([, a], [, b]) => a.mae - b.mae)
    .map(([s, st]) =>
      `  ${s.padEnd(16)} MAE=${st.mae.toFixed(3)} RMSE=${st.rmse.toFixed(3)} bias=${st.bias >= 0 ? '+' : ''}${st.bias.toFixed(3)} (n=${st.count})`
    )
    .join('\n')

  const currentWeightsStr = Object.entries(currentWeights)
    .map(([s, w]) => `${s}: ${(w * 100).toFixed(1)}%`)
    .join(', ')

  const tomorrowBlock = tomorrowDate
    ? `\nPREDICCIÓN DE MAÑANA (${tomorrowDate}):
  Ensemble bruto: ${tomorrowEnsemble?.toFixed(3) ?? 'N/A'}°C
  Fuentes: ${JSON.stringify(tomorrowSources ?? {})}
  (Calcula proposedTokenA = ceil(ensemble + optimalBias), proposedTokenB = proposedTokenA + 1)`
    : '\nPREDICCIÓN DE MAÑANA: no disponible (proposedTokenA y proposedTokenB = null)'

  return `ANÁLISIS SOLICITADO: ${mode.toUpperCase()}
VENTANA DE HISTÓRICO: ${N} ciclos liquidados

═══════════════════════════════════════════
ESTADÍSTICAS GLOBALES
═══════════════════════════════════════════
Hit rate actual:          ${(hitRate * 100).toFixed(1)}%
Error medio ensemble:     ${avgErrorRaw.toFixed(3)}°C (sin bias)
Error medio con bias:     ${avgErrorAdj.toFixed(3)}°C (con bias aplicado)
Offset miss medio:        ${avgOffMiss.toFixed(3)}  (ceil(actual) - tokenA)

═══════════════════════════════════════════
RENDIMIENTO POR FUENTE METEOROLÓGICA
═══════════════════════════════════════════
${sourceTable}

PESOS ACTUALES EN PRODUCCIÓN:
${currentWeightsStr}

═══════════════════════════════════════════
SIMULACIÓN DE HIT RATE POR VALOR DE BIAS
═══════════════════════════════════════════
${biasTable}

═══════════════════════════════════════════
MUESTRA DE LOS ÚLTIMOS ${recentSample.length} CICLOS
═══════════════════════════════════════════
${JSON.stringify(recentSample, null, 2)}
${tomorrowBlock}

═══════════════════════════════════════════
INSTRUCCIONES DE OPTIMIZACIÓN
═══════════════════════════════════════════
${mode !== 'bias' ? `
1. PESOS DE FUENTES: Calcula pesos óptimos usando MAE inverso (1/MAE normalizado) como punto de partida.
   Ajusta manualmente si una fuente tiene bias sistemático alto (en valor absoluto).
   Los pesos deben sumar exactamente 1.0 y ninguno ser negativo.
   Incluye SOLO las fuentes que aparecen en sourceStats.` : ''}
${mode !== 'weights' ? `
2. BIAS ÓPTIMO: Identifica el valor de bias N que maximiza el hit rate según la tabla de simulación.
   Considera también el error sistemático del ensemble (avgErrorRaw):
   si el ensemble subestima sistemáticamente la temperatura real, N debe ser positivo.
   Propón el bias como un valor con 1 decimal (e.g. 0.5, -1.0, 1.5).` : ''}

3. INSIGHTS: Identifica patrones relevantes en los últimos ciclos (tendencia del error, 
   fuentes más/menos fiables, comportamiento del mercado).

4. WARNINGS: Señala cualquier anomalía, número de datos insuficiente (< 20 ciclos = baja confianza),
   o riesgo en las recomendaciones.

Responde SOLO con el JSON estructurado indicado.`
}
