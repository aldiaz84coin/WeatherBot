# 🌡️ madrid-temp-bot

Bot de predicción de temperatura máxima en Madrid que opera en Polymarket.  
Arquitectura: **Railway** (bot) · **Supabase** (base de datos) · **Vercel** (dashboard)

---

## Objetivo principal

> **Encontrar la combinación de 3 tokens de Polymarket cuya compra conjunta (coste total < 0.80 USDC) habría acertado en más del 90% de los días del último año.**

El bot no busca maximizar el retorno esperado de una sola apuesta: busca una estrategia de cobertura de tres posiciones (`predicción-1°`, `predicción`, `predicción+1°`) lo suficientemente robusta como para resolver en positivo el 90%+ de las veces, con un desembolso por día inferior a 0.80 USDC.

---

## Fases

### Fase 1 — Entrenamiento y validación histórica ⭐

**Objetivo concreto y medible:**
Dado el histórico de los últimos 365 días en Madrid, encontrar el método de predicción (fuente única o ensemble ponderado de las 10 fuentes) que, al aplicar la estrategia de 3 tokens `[pred-1°, pred°, pred+1°]` con presupuesto < 0.80 USDC/día, habría acertado (al menos un token resuelve en `YES`) en ≥ 90% de los días.

**Pasos:**
1. Recopilar datos históricos de temperatura máxima real en Madrid (fuente ground truth: AEMET + Copernicus ERA5).
2. Obtener, para cada día del año pasado, qué habría predicho cada una de las 10 fuentes **el día anterior**.
3. Cruzar con los slugs históricos de Polymarket para obtener precios reales de cada token en el momento de compra (≈18:00 CET del día anterior).
4. Simular la compra de `[pred-1, pred, pred+1]` con distribución de gasto `[0.20, 0.40, 0.20]` USDC (total = 0.80).
5. Calcular tasa de acierto: ¿resolvió en YES al menos uno de los tres tokens?
6. Iterar sobre distintas combinaciones de fuentes y pesos hasta encontrar la que supera el umbral del 90%.
7. Guardar los pesos óptimos del ensemble en Supabase como configuración activa del bot.

**Criterio de paso a Fase 2:** tasa de acierto ≥ 90% en validación cruzada (últimos 90 días fuera del entrenamiento).

---

### Fase 2 — Predicción diaria y construcción de la posición

1. El bot se ejecuta cada día a las **18:00 CET**.
2. Consulta las 10 fuentes con los pesos aprendidos en Fase 1 para obtener `pred` (temperatura máxima del día siguiente en Madrid).
3. Construye la posición:
   ```
   tokens = [pred - 1°, pred, pred + 1°]
   gasto  = [0.20,     0.40, 0.20] USDC  →  total = 0.80 USDC
   ```
4. Consulta precios actuales en Polymarket (Gamma API) para los tres slugs.
5. Ajusta la distribución de gasto según los precios de mercado (si un token está muy caro, redistribuir).
6. Registra la predicción en Supabase antes de ejecutar ninguna orden.

---

### Fase 3 — Simulación y automatización

1. **Modo simulación** (activo por defecto): el bot ejecuta todos los pasos pero **no llama a la CLOB API**. Registra las órdenes como `simulated: true` en Supabase.
2. Cada día al resolver el mercado, el bot actualiza el resultado y calcula P&L simulado.
3. **Criterio de activación real:** 14 días consecutivos en simulación con tasa de acierto ≥ 90% y P&L simulado positivo.
4. Un flag `LIVE_TRADING=true` en las variables de entorno de Railway activa el modo real.
5. El dashboard de Vercel muestra en tiempo real el estado del bot, las predicciones, las posiciones y el P&L acumulado.

---

## Estructura del repositorio

```
madrid-temp-bot/
│
├── packages/
│   ├── bot/                        # Railway — Node.js / TypeScript
│   │   ├── src/
│   │   │   ├── sources/            # Adaptadores para cada fuente de datos
│   │   │   │   ├── aemet.ts
│   │   │   │   ├── open-meteo.ts
│   │   │   │   ├── openweathermap.ts
│   │   │   │   ├── accuweather.ts
│   │   │   │   ├── weatherapi.ts
│   │   │   │   ├── visual-crossing.ts
│   │   │   │   ├── meteored.ts
│   │   │   │   ├── windy.ts
│   │   │   │   ├── tomorrow-io.ts
│   │   │   │   ├── copernicus.ts
│   │   │   │   └── index.ts        # WeatherSourceManager
│   │   │   ├── training/
│   │   │   │   ├── backtest.ts     # ⭐ Loop de 365 días
│   │   │   │   ├── ensemble.ts     # Optimización de pesos
│   │   │   │   └── validator.ts    # Criterio 90% / validación cruzada
│   │   │   ├── polymarket/
│   │   │   │   ├── gamma.ts        # Leer mercados y precios
│   │   │   │   ├── clob.ts         # Ejecutar órdenes (real)
│   │   │   │   └── slugs.ts        # Generador de slugs diarios
│   │   │   ├── prediction/
│   │   │   │   ├── predict.ts      # Predicción del día siguiente
│   │   │   │   └── position.ts     # Construcción de los 3 tokens
│   │   │   ├── db/
│   │   │   │   └── supabase.ts     # Cliente Supabase + helpers
│   │   │   ├── scheduler.ts        # Cron job 18:00 CET
│   │   │   └── index.ts            # Entrypoint
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── dashboard/                  # Vercel — Next.js 14 App Router
│       ├── app/
│       │   ├── page.tsx            # Overview: estado bot + P&L
│       │   ├── predictions/        # Historial de predicciones
│       │   ├── training/           # Resultados del backtest
│       │   └── api/
│       │       └── revalidate/     # Webhook desde Supabase realtime
│       ├── components/
│       │   ├── BotStatus.tsx
│       │   ├── PredictionCard.tsx
│       │   ├── PnlChart.tsx
│       │   └── TrainingResults.tsx
│       ├── lib/
│       │   └── supabase.ts
│       └── package.json
│
├── supabase/
│   └── migrations/
│       ├── 001_initial_schema.sql
│       └── 002_training_results.sql
│
├── .env.example
├── package.json                    # Workspace raíz (pnpm)
└── README.md
```

---

## Base de datos — Supabase (schema)

### `weather_sources`
Configuración y pesos aprendidos de cada fuente.

| columna | tipo | descripción |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | nombre de la fuente |
| `weight` | float | peso en el ensemble (0–1, suma=1) |
| `rmse_365d` | float | RMSE en el backtest |
| `active` | bool | si se usa en producción |
| `updated_at` | timestamptz | |

### `predictions`
Una fila por día de predicción.

| columna | tipo | descripción |
|---|---|---|
| `id` | uuid PK | |
| `target_date` | date | fecha predicha (mañana) |
| `predicted_at` | timestamptz | cuándo se generó |
| `ensemble_temp` | float | temperatura predicha por el ensemble |
| `source_temps` | jsonb | `{aemet: 32.1, open_meteo: 31.8, ...}` |
| `token_low` | float | pred - 1° |
| `token_mid` | float | pred |
| `token_high` | float | pred + 1° |
| `total_cost_usdc` | float | coste total de los 3 tokens |
| `simulated` | bool | true = modo simulación |

### `trades`
Una fila por token comprado (3 por día).

| columna | tipo | descripción |
|---|---|---|
| `id` | uuid PK | |
| `prediction_id` | uuid FK | |
| `slug` | text | slug de Polymarket |
| `token_temp` | float | temperatura del token |
| `side` | text | `YES` |
| `cost_usdc` | float | importe comprado |
| `price_at_buy` | float | precio en el momento de compra (0–1) |
| `shares` | float | número de shares |
| `simulated` | bool | |
| `polymarket_order_id` | text | null si simulado |

### `results`
Resolución del mercado y P&L.

| columna | tipo | descripción |
|---|---|---|
| `id` | uuid PK | |
| `prediction_id` | uuid FK | |
| `target_date` | date | |
| `actual_temp` | float | temperatura máxima real |
| `resolved_token` | float | qué token resolvió en YES |
| `won` | bool | ¿ganamos? |
| `pnl_usdc` | float | ganancia/pérdida neta |

### `training_runs`
Historial de ejecuciones de backtest.

| columna | tipo | descripción |
|---|---|---|
| `id` | uuid PK | |
| `run_at` | timestamptz | |
| `days_tested` | int | |
| `hit_rate` | float | tasa de acierto (0–1) |
| `best_ensemble` | jsonb | pesos óptimos encontrados |
| `passed` | bool | ≥ 0.90 hit rate |

---

## Variables de entorno

```bash
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Polymarket
POLYMARKET_API_KEY=
POLYMARKET_PRIVATE_KEY=          # para CLOB (órdenes reales)

# Fuentes de datos
AEMET_API_KEY=
OPENWEATHER_API_KEY=
ACCUWEATHER_API_KEY=
WEATHERAPI_KEY=
VISUAL_CROSSING_KEY=
TOMORROW_IO_KEY=

# Bot
LIVE_TRADING=false               # ⚠️ cambiar a true solo tras validación
TZ=Europe/Madrid
```

---

## Fuentes de datos

| # | Fuente | API | Histórico | Gratuita |
|---|---|---|---|---|
| 1 | AEMET | REST v1 | ✅ | ✅ (registro) |
| 2 | Open-Meteo | REST | ✅ 80 años | ✅ |
| 3 | OpenWeatherMap | REST | ✅ 5 días paid | Freemium |
| 4 | AccuWeather | REST | ⚠️ limitado | Freemium |
| 5 | WeatherAPI.com | REST | ✅ 1 año free | Freemium |
| 6 | Visual Crossing | REST | ✅ histórico completo | Freemium |
| 7 | Meteored | Scraping | ❌ | — |
| 8 | Windy (ECMWF) | REST | ⚠️ forecast only | Freemium |
| 9 | Tomorrow.io | REST | ⚠️ limitado | Freemium |
| 10 | Copernicus ERA5 | CDS API | ✅ gold standard | ✅ |

> Para el **backtest** (Fase 1), Visual Crossing y Open-Meteo son las fuentes más útiles por su histórico gratuito y completo. ERA5 es el ground truth para validar temperaturas reales.

---

## Desarrollo local

```bash
# Instalar dependencias (pnpm workspaces)
pnpm install

# Arrancar el bot en local
cd packages/bot
pnpm dev

# Arrancar el dashboard en local
cd packages/dashboard
pnpm dev

# Correr el backtest manualmente
cd packages/bot
pnpm backtest

# Aplicar migraciones de Supabase
supabase db push
```

---

## Despliegue

| Servicio | Comando | Notas |
|---|---|---|
| Railway | `git push` (autodeploy) | Usar `packages/bot` como root |
| Vercel | `git push` (autodeploy) | Usar `packages/dashboard` como root |
| Supabase | `supabase db push` | Migraciones en `supabase/migrations/` |

---

## Roadmap

- [x] README y arquitectura
- [ ] Schema Supabase + migraciones
- [ ] Adaptadores de fuentes de datos (10 fuentes)
- [ ] ⭐ Algoritmo de backtest Fase 1
- [ ] Optimizador de ensemble (criterio 90%)
- [ ] Integración Polymarket Gamma API
- [ ] Scheduler diario (Fase 2)
- [ ] Modo simulación (Fase 3)
- [ ] Dashboard Vercel
- [ ] Activación LIVE_TRADING

---

*Proyecto en desarrollo activo. No usar en modo LIVE_TRADING sin haber superado el criterio de validación del 90%.*
