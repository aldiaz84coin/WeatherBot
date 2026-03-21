-- ============================================================
-- 002_training_results.sql
-- Índices adicionales y helpers para resultados de entrenamiento
-- ============================================================

-- Vista de comparación de fuentes (para el dashboard de entrenamiento)
create or replace view v_source_comparison as
select
  ws.name,
  ws.slug,
  ws.weight,
  ws.rmse_365d,
  ws.bias,
  ws.active,
  -- Ranking por RMSE
  rank() over (order by ws.rmse_365d asc nulls last) as rmse_rank
from weather_sources ws
where ws.active = true;

-- Vista de evolución del hit rate por mes
create or replace view v_monthly_performance as
select
  date_trunc('month', r.target_date) as month,
  count(*) as total_days,
  count(*) filter (where r.won) as wins,
  round(
    count(*) filter (where r.won)::numeric / nullif(count(*), 0) * 100,
    1
  ) as hit_rate_pct,
  round(sum(r.pnl_net_usdc)::numeric, 4) as monthly_pnl
from results r
group by 1
order by 1 desc;

-- Función helper para calcular hit rate de los últimos N días
create or replace function hit_rate_last_n_days(n int default 30)
returns float
language sql stable as $$
  select
    count(*) filter (where won)::float / nullif(count(*), 0)
  from results
  where target_date >= current_date - n
$$;

-- Índice para acelerar consultas de rendimiento por fecha
create index if not exists idx_results_target_date on results (target_date desc);
create index if not exists idx_results_won on results (won);
create index if not exists idx_predictions_simulated on predictions (simulated, target_date desc);
