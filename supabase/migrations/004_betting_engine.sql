-- ============================================================
-- 004_betting_engine.sql
-- Motor de apuestas con Martingala + log de eventos del bot
-- ============================================================

-- ─── Dependencia: bot_config (creada en 003, garantizamos existencia) ────────
create table if not exists bot_config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz default now()
);

-- ─── betting_cycles ──────────────────────────────────────────
-- Una fila por día de operación. Registra el ciclo completo:
-- predicción → compra → resultado → ajuste de stake.

create table if not exists betting_cycles (
  id               uuid primary key default uuid_generate_v4(),
  target_date      date not null unique,        -- día al que va la apuesta
  created_at       timestamptz default now(),
  settled_at       timestamptz,

  -- ─ Stake ─────────────────────────────────────────────────
  base_stake_usdc  float not null,              -- stake base (config)
  multiplier       float not null default 1,    -- 1, 2, 4, 8 … (Martingala)
  stake_usdc       float not null,              -- stake real = min(base*mult, max)
  capped_at_max    boolean not null default false, -- ¿llegó al tope?

  -- ─ Predicción ────────────────────────────────────────────
  ensemble_temp    float,                       -- temperatura predicha
  token_a_temp     int,                         -- token comprado A (ceil(pred))
  token_b_temp     int,                         -- token comprado B (ceil(pred)+1)
  price_a          float,                       -- precio YES token A en el momento de compra
  price_b          float,                       -- precio YES token B
  shares           float,                       -- nº de shares de CADA token (igual para los dos)
  cost_a_usdc      float,                       -- coste real token A = shares * price_a
  cost_b_usdc      float,                       -- coste real token B = shares * price_b

  -- ─ Link con tablas existentes ────────────────────────────
  prediction_id    uuid references predictions(id),

  -- ─ Resultado ─────────────────────────────────────────────
  status           text not null default 'pending'
                   check (status in ('pending','open','won','lost','skipped','error')),
  actual_temp      float,                       -- temperatura real registrada
  winning_token    int,                         -- qué token resolvió YES (null si perdida)
  pnl_usdc         float,                       -- P&L neto del ciclo

  -- ─ Modo ──────────────────────────────────────────────────
  simulated        boolean not null default true,

  -- ─ Metadata ──────────────────────────────────────────────
  source_temps     jsonb,                       -- snapshot de cada fuente en el momento de predicción
  weights_used     jsonb                        -- pesos del ensemble aplicados
);

create index if not exists idx_betting_cycles_date   on betting_cycles (target_date desc);
create index if not exists idx_betting_cycles_status on betting_cycles (status);

-- ─── bot_events ──────────────────────────────────────────────
-- Log operacional del bot. Todo lo que hace queda registrado aquí.
-- El dashboard lo consume para mostrar el estado en tiempo real.

create table if not exists bot_events (
  id          uuid primary key default uuid_generate_v4(),
  occurred_at timestamptz default now(),

  -- Clasificación del evento
  event_type  text not null check (event_type in (
    'startup',        -- bot arranca
    'prediction',     -- ciclo de predicción ejecutado
    'settlement',     -- liquidación del mercado
    'stake_reset',    -- stake vuelve a base (win)
    'stake_doubled',  -- stake doblado (loss, Martingala)
    'stake_capped',   -- stake llegó al máximo
    'weight_update',  -- optimización de pesos de fuentes
    'error',          -- error en cualquier fase
    'info',           -- mensajes informativos
    'market_pending'  -- mercado aún no resuelto
  )),
  severity    text not null default 'info'
              check (severity in ('info','warn','error','success')),

  message     text not null,
  payload     jsonb,                            -- datos estructurados del evento

  -- Referencias opcionales
  cycle_id    uuid references betting_cycles(id)
);

create index if not exists idx_bot_events_occurred on bot_events (occurred_at desc);
create index if not exists idx_bot_events_type     on bot_events (event_type, occurred_at desc);
create index if not exists idx_bot_events_severity on bot_events (severity, occurred_at desc);

-- Vista: últimos 100 eventos con info del ciclo
create or replace view v_bot_events_recent as
select
  e.id,
  e.occurred_at,
  e.event_type,
  e.severity,
  e.message,
  e.payload,
  bc.target_date     as cycle_date,
  bc.stake_usdc      as cycle_stake,
  bc.status          as cycle_status
from bot_events e
left join betting_cycles bc on bc.id = e.cycle_id
order by e.occurred_at desc
limit 100;

-- Vista: estado actual del motor de apuestas
create or replace view v_betting_status as
select
  -- Ciclo más reciente
  bc.id              as latest_cycle_id,
  bc.target_date     as latest_date,
  bc.status          as latest_status,
  bc.stake_usdc      as latest_stake,
  bc.multiplier      as latest_multiplier,
  bc.token_a_temp,
  bc.token_b_temp,
  bc.shares,
  bc.cost_a_usdc,
  bc.cost_b_usdc,
  bc.actual_temp,
  bc.status in ('won','lost') as is_settled,
  bc.pnl_usdc        as latest_pnl,
  bc.simulated,

  -- Configuración activa
  (select value::float from bot_config where key = 'base_stake_usdc')     as base_stake,
  (select value::float from bot_config where key = 'max_stake_usdc')      as max_stake,
  (select value::float from bot_config where key = 'current_multiplier')  as current_multiplier,
  (select value::int   from bot_config where key = 'consecutive_losses')  as consecutive_losses,
  (select value::text  from bot_config where key = 'betting_mode')        as betting_mode,

  -- KPIs acumulados de betting_cycles
  agg.total_cycles,
  agg.won_cycles,
  agg.lost_cycles,
  agg.total_pnl,
  agg.hit_rate_pct

from betting_cycles bc
cross join lateral (
  select
    count(*)                                               as total_cycles,
    count(*) filter (where status = 'won')                 as won_cycles,
    count(*) filter (where status = 'lost')                as lost_cycles,
    round(coalesce(sum(pnl_usdc), 0)::numeric, 4)          as total_pnl,
    round(
      100.0 * count(*) filter (where status = 'won')
      / nullif(count(*) filter (where status in ('won','lost')), 0)
    , 1)                                                   as hit_rate_pct
  from betting_cycles
) agg
order by bc.target_date desc
limit 1;

-- ─── Configuración del motor de apuestas ─────────────────────
insert into bot_config (key, value, description) values
  ('base_stake_usdc',    '20',           'Stake base diario en USDC'),
  ('max_stake_usdc',     '160',          'Stake máximo — la Martingala se detiene aquí'),
  ('current_multiplier', '1',            'Multiplicador actual (1=base, 2=doblar, etc.)'),
  ('consecutive_losses', '0',            'Racha de pérdidas consecutivas'),
  ('betting_mode',       '"simulated"',  'Modo de operación: simulated | live'),
  ('prediction_hour_betting', '0',       'Hora (Europe/Madrid) del ciclo de apuesta'),
  ('prediction_minute_betting','30',     'Minuto del ciclo de apuesta')
on conflict (key) do nothing;

-- ─── RLS ─────────────────────────────────────────────────────
alter table betting_cycles enable row level security;
alter table bot_events     enable row level security;

create policy "service full access" on betting_cycles for all using (true);
create policy "service full access" on bot_events     for all using (true);
create policy "anon read"           on betting_cycles for select using (true);
create policy "anon read"           on bot_events     for select using (true);
