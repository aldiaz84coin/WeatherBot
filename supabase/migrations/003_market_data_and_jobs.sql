-- ============================================================
-- 003_market_data_and_jobs.sql
-- Cache de datos de Polymarket, sistema de jobs para backtest
-- y configuración del bot desde el dashboard
-- ============================================================

-- ─── market_data_cache ───────────────────────────────────────
-- Cache de mercados de Polymarket por fecha (evita llamadas repetidas a la API)
create table if not exists market_data_cache (
  id           uuid primary key default uuid_generate_v4(),
  market_date  date not null unique,
  payload      jsonb not null,  -- DayMarkets completo
  token_count  int generated always as ((payload->>'tokens')::json->>'length' is not null
                                         and jsonb_array_length(payload->'tokens') or 0) stored,
  fetched_at   timestamptz default now(),
  is_resolved  boolean generated always as (
    (payload->>'resolvedTemp') is not null
  ) stored
);

-- Helper real: contar tokens
alter table market_data_cache drop column if exists token_count;
alter table market_data_cache add column token_count int;

-- Actualizar token_count vía trigger
create or replace function update_token_count()
returns trigger language plpgsql as $$
begin
  new.token_count := jsonb_array_length(new.payload->'tokens');
  return new;
end;
$$;

create trigger trg_market_token_count
before insert or update on market_data_cache
for each row execute function update_token_count();

create index if not exists idx_market_cache_date on market_data_cache (market_date desc);
create index if not exists idx_market_cache_resolved on market_data_cache (is_resolved);

-- ─── bot_config ───────────────────────────────────────────────
-- Configuración centralizada del bot (editable desde el dashboard)
create table if not exists bot_config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz default now()
);

-- Configuración inicial
insert into bot_config (key, value, description) values
  ('daily_budget_usdc',  '0.80',  'Presupuesto máximo por día en USDC'),
  ('token_window',       '1',     'Rango de temperaturas ± alrededor de la predicción'),
  ('active_sources',     '["open-meteo","copernicus","aemet","visual-crossing"]',
                         'Fuentes activas para el ensemble'),
  ('live_trading',       'false', 'Activar operaciones reales en Polymarket'),
  ('min_token_price',    '0.02',  'Precio mínimo de token para incluirlo (evita tokens imposibles)'),
  ('max_token_price',    '0.95',  'Precio máximo de token (muy probables, poca ganancia)'),
  ('prediction_hour',    '18',    'Hora del día (Europe/Madrid) para ejecutar predicción diaria')
on conflict (key) do nothing;

-- ─── backtest_jobs ────────────────────────────────────────────
-- Jobs de backtest creados desde el dashboard y ejecutados por el bot
create table if not exists backtest_jobs (
  id           uuid primary key default uuid_generate_v4(),
  created_at   timestamptz default now(),
  started_at   timestamptz,
  finished_at  timestamptz,

  -- Parámetros del backtest
  config       jsonb not null default '{}',
  -- {
  --   start_date: "YYYY-MM-DD",
  --   end_date: "YYYY-MM-DD",
  --   budget: 0.80,
  --   sources: ["open-meteo", ...],
  --   use_real_polymarket: true
  -- }

  status       text not null default 'pending'
               check (status in ('pending', 'running', 'done', 'error')),

  -- Resultado final (se rellena al terminar)
  result       jsonb,
  error_msg    text,

  -- Referencia al training_run generado
  training_run_id uuid references training_runs(id)
);

create index if not exists idx_backtest_jobs_status on backtest_jobs (status, created_at desc);

-- ─── backtest_logs ────────────────────────────────────────────
-- Logs en tiempo real del backtest (para el dashboard)
create table if not exists backtest_logs (
  id         bigserial primary key,
  job_id     uuid not null references backtest_jobs(id) on delete cascade,
  created_at timestamptz default now(),
  level      text not null default 'info' check (level in ('info', 'warn', 'error', 'success')),
  message    text not null,
  data       jsonb  -- datos estructurados opcionales
);

create index if not exists idx_backtest_logs_job on backtest_logs (job_id, created_at asc);

-- ─── Vista: resumen de jobs de backtest ───────────────────────
create or replace view v_backtest_jobs as
select
  j.id,
  j.created_at,
  j.started_at,
  j.finished_at,
  j.status,
  j.config,
  j.result->>'hitRate' as hit_rate,
  j.result->>'totalDays' as total_days,
  j.result->>'hitCount' as hit_count,
  (j.result->>'hitRate')::float >= 0.90 as passed,
  j.error_msg,
  extract(epoch from (j.finished_at - j.started_at))::int as duration_seconds,
  j.training_run_id
from backtest_jobs j
order by j.created_at desc;

-- ─── RLS para nuevas tablas ───────────────────────────────────
alter table market_data_cache enable row level security;
alter table bot_config       enable row level security;
alter table backtest_jobs    enable row level security;
alter table backtest_logs    enable row level security;

create policy "service full access" on market_data_cache for all using (true);
create policy "service full access" on bot_config       for all using (true);
create policy "service full access" on backtest_jobs    for all using (true);
create policy "service full access" on backtest_logs    for all using (true);

create policy "anon read" on market_data_cache for select using (true);
create policy "anon read" on bot_config       for select using (true);
create policy "anon read" on backtest_jobs    for select using (true);
create policy "anon read" on backtest_logs    for select using (true);
