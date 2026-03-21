-- ============================================================
-- 001_initial_schema.sql
-- Madrid Temp Bot — esquema inicial
-- ============================================================

-- Extensiones
create extension if not exists "uuid-ossp";

-- ─── weather_sources ────────────────────────────────────────
-- Configuración y pesos aprendidos del ensemble
create table weather_sources (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  slug        text not null unique,         -- identificador en código
  weight      float not null default 0.1,   -- peso en el ensemble (0–1)
  rmse_365d   float,                        -- RMSE del último backtest
  bias        float,                        -- sesgo sistemático (°C)
  active      boolean not null default true,
  updated_at  timestamptz default now()
);

insert into weather_sources (name, slug, weight) values
  ('AEMET',           'aemet',           0.15),
  ('Open-Meteo',      'open-meteo',      0.15),
  ('OpenWeatherMap',  'openweathermap',  0.10),
  ('AccuWeather',     'accuweather',     0.10),
  ('WeatherAPI',      'weatherapi',      0.10),
  ('Visual Crossing', 'visual-crossing', 0.15),
  ('Meteored',        'meteored',        0.05),
  ('Windy',           'windy',           0.05),
  ('Tomorrow.io',     'tomorrow-io',     0.10),
  ('Copernicus ERA5', 'copernicus',      0.05);

-- ─── training_runs ──────────────────────────────────────────
-- Historial de ejecuciones del backtest
create table training_runs (
  id             uuid primary key default uuid_generate_v4(),
  run_at         timestamptz default now(),
  days_tested    int not null,
  hit_rate       float not null,           -- tasa de acierto (0.0 – 1.0)
  -- ⭐ OBJETIVO: hit_rate >= 0.90
  passed         boolean generated always as (hit_rate >= 0.90) stored,
  best_ensemble  jsonb not null,           -- {source_slug: weight, ...}
  config         jsonb,                    -- parámetros usados (ventana, distribución, etc.)
  notes          text
);

-- ─── predictions ────────────────────────────────────────────
-- Una fila por día, generada a las 18:00 CET del día anterior
create table predictions (
  id              uuid primary key default uuid_generate_v4(),
  target_date     date not null unique,
  predicted_at    timestamptz default now(),

  -- Temperaturas por fuente (snapshot en el momento de predecir)
  source_temps    jsonb not null default '{}',  -- {aemet: 32.1, open_meteo: 31.8, ...}

  -- Resultado del ensemble
  ensemble_temp   float not null,               -- temperatura predicha (°C)

  -- Posición: los 3 tokens
  token_low       float not null,               -- ensemble_temp - 1°
  token_mid       float not null,               -- ensemble_temp
  token_high      float not null,               -- ensemble_temp + 1°

  -- Costes
  cost_low_usdc   float not null default 0.20,
  cost_mid_usdc   float not null default 0.40,
  cost_high_usdc  float not null default 0.20,
  total_cost_usdc float generated always as (cost_low_usdc + cost_mid_usdc + cost_high_usdc) stored,
  -- ⚠️ Restricción: total siempre < 0.80 USDC
  constraint total_cost_under_limit check (cost_low_usdc + cost_mid_usdc + cost_high_usdc < 0.80),

  simulated       boolean not null default true,
  ensemble_config jsonb  -- snapshot de los pesos usados
);

-- ─── trades ─────────────────────────────────────────────────
-- Una fila por token comprado (3 por predicción)
create table trades (
  id                   uuid primary key default uuid_generate_v4(),
  prediction_id        uuid not null references predictions(id),
  created_at           timestamptz default now(),

  slug                 text not null,    -- highest-temperature-in-madrid-on-YYYY-MM-DD
  token_temp           float not null,   -- la temperatura del token (low/mid/high)
  position             text not null check (position in ('low', 'mid', 'high')),

  cost_usdc            float not null,
  price_at_buy         float,            -- precio del token en Polymarket (0.0 – 1.0)
  shares               float,            -- cost / price_at_buy

  simulated            boolean not null default true,
  polymarket_order_id  text,             -- null si simulado
  status               text not null default 'open' check (status in ('open', 'resolved', 'cancelled'))
);

-- ─── results ────────────────────────────────────────────────
-- Resolución del mercado (se rellena al día siguiente)
create table results (
  id               uuid primary key default uuid_generate_v4(),
  prediction_id    uuid not null references predictions(id) unique,
  target_date      date not null,
  resolved_at      timestamptz default now(),

  actual_temp      float not null,         -- temperatura máxima real del día
  resolved_token   float,                  -- a qué temperatura resolvió el mercado
  won              boolean not null,        -- ¿algún token resolvió en YES?
  winning_position text check (winning_position in ('low', 'mid', 'high', null)),

  -- P&L detallado
  pnl_gross_usdc   float not null default 0,
  cost_usdc        float not null default 0.80,
  pnl_net_usdc     float generated always as (pnl_gross_usdc - cost_usdc) stored,

  source           text not null default 'polymarket'  -- fuente del resultado
);

-- ─── Índices ────────────────────────────────────────────────
create index on predictions (target_date desc);
create index on trades (prediction_id);
create index on results (target_date desc);
create index on training_runs (run_at desc);

-- ─── Vistas útiles ──────────────────────────────────────────

-- Vista de rendimiento acumulado
create view v_performance as
select
  count(*) filter (where won) as wins,
  count(*) filter (where not won) as losses,
  count(*) as total,
  round((count(*) filter (where won))::numeric / nullif(count(*),0) * 100, 1) as hit_rate_pct,
  round(sum(pnl_net_usdc)::numeric, 4) as cumulative_pnl,
  round(avg(pnl_net_usdc)::numeric, 4) as avg_daily_pnl
from results;

-- Vista diaria con todo el contexto
create view v_daily_summary as
select
  p.target_date,
  p.ensemble_temp,
  p.token_low,
  p.token_mid,
  p.token_high,
  p.total_cost_usdc,
  p.simulated,
  r.actual_temp,
  r.won,
  r.winning_position,
  r.pnl_net_usdc
from predictions p
left join results r on r.prediction_id = p.id
order by p.target_date desc;

-- ─── Row Level Security ─────────────────────────────────────
alter table predictions   enable row level security;
alter table trades        enable row level security;
alter table results       enable row level security;
alter table training_runs enable row level security;
alter table weather_sources enable row level security;

-- El bot (service key) tiene acceso total; el dashboard (anon) solo lectura
create policy "service full access" on predictions   for all using (true);
create policy "service full access" on trades        for all using (true);
create policy "service full access" on results       for all using (true);
create policy "service full access" on training_runs for all using (true);
create policy "service full access" on weather_sources for all using (true);

create policy "anon read" on predictions   for select using (true);
create policy "anon read" on trades        for select using (true);
create policy "anon read" on results       for select using (true);
create policy "anon read" on training_runs for select using (true);
create policy "anon read" on weather_sources for select using (true);
