# Guía de despliegue — madrid-temp-bot

## 0. Prerequisitos

Instala estas herramientas si no las tienes:

```bash
# Node.js 20+
node --version

# pnpm
npm install -g pnpm

# Git
git --version

# CLIs de Vercel y Railway
npm install -g vercel
npm install -g @railway/cli

# CLI de Supabase (opcional pero útil)
npm install -g supabase
```

---

## 1. Supabase — base de datos

Antes de subir a ningún sitio, necesitas la base de datos lista.

### 1.1 Crear proyecto

1. Ve a [supabase.com](https://supabase.com) → **New project**
2. Nombre: `madrid-temp-bot`
3. Elige región: **West EU (Ireland)** — más cerca de Madrid
4. Anota la contraseña de la base de datos en un lugar seguro
5. Espera ~2 minutos a que el proyecto arranque

### 1.2 Obtener credenciales

En el dashboard de Supabase → **Settings → API**:

```
SUPABASE_URL              →  https://xxxx.supabase.co
SUPABASE_SERVICE_KEY      →  eyJ... (service_role, en "Project API keys")
SUPABASE_ANON_KEY         →  eyJ... (anon, en "Project API keys")
```

⚠️ La `service_key` es secreta — solo va en Railway. La `anon_key` puede ir en Vercel (es pública).

### 1.3 Aplicar el schema

**Opción A — SQL Editor (más rápido):**

1. En Supabase → **SQL Editor** → **New query**
2. Pega el contenido de `supabase/migrations/001_initial_schema.sql`
3. Click **Run**
4. Verifica que aparecen las tablas en **Table Editor**

**Opción B — CLI:**

```bash
# Desde la raíz del repo (cuando ya esté en local)
supabase login
supabase link --project-ref xxxx   # el ID está en Settings → General
supabase db push
```

---

## 2. GitHub

### 2.1 Crear el repositorio

1. Ve a [github.com/new](https://github.com/new)
2. Nombre: `madrid-temp-bot`
3. Visibilidad: **Private** (tiene API keys en `.env.example`)
4. **No** marques "Initialize with README" — ya tienes uno
5. Click **Create repository**

### 2.2 Subir el código

```bash
# Entra en la carpeta del proyecto
cd madrid-temp-bot

# Inicializa git
git init

# Verifica que .gitignore está correcto (no debe subir .env ni node_modules)
cat .gitignore

# Añade todo
git add .

# Primer commit
git commit -m "feat: scaffold inicial — bot + dashboard + supabase schema"

# Conecta con GitHub (sustituye TU_USUARIO por tu usuario de GitHub)
git remote add origin https://github.com/TU_USUARIO/madrid-temp-bot.git

# Sube
git branch -M main
git push -u origin main
```

### 2.3 Verificar en GitHub

Comprueba que en github.com/TU_USUARIO/madrid-temp-bot aparece la estructura:
```
packages/
  bot/
  dashboard/
supabase/
README.md
railway.toml
```

---

## 3. Vercel — dashboard

### 3.1 Conectar el repo

1. Ve a [vercel.com/new](https://vercel.com/new)
2. Click **Import Git Repository** → conecta tu cuenta de GitHub si no lo has hecho
3. Busca `madrid-temp-bot` → click **Import**

### 3.2 Configurar el proyecto

En la pantalla de configuración antes de hacer deploy:

| Campo | Valor |
|---|---|
| **Framework Preset** | Next.js |
| **Root Directory** | `packages/dashboard` |
| **Build Command** | `pnpm build` (autodetectado) |
| **Output Directory** | `.next` (autodetectado) |
| **Install Command** | `pnpm install` |

### 3.3 Variables de entorno

En **Environment Variables**, añade:

```
NEXT_PUBLIC_SUPABASE_URL        =  https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY   =  eyJ...  (la anon key)
NEXT_PUBLIC_LIVE_TRADING        =  false
```

### 3.4 Deploy

Click **Deploy** → espera ~2 minutos.

Vercel te dará una URL del tipo `madrid-temp-bot-xxxx.vercel.app`. El dashboard ya está online aunque sin datos todavía.

### 3.5 Redeploys automáticos

Cada `git push` a `main` disparará un nuevo deploy en Vercel automáticamente.

---

## 4. Railway — bot

### 4.1 Login y crear proyecto

```bash
# Login desde terminal
railway login
# Se abrirá el navegador para autenticar

# Crear nuevo proyecto
railway init
# Nombre: madrid-temp-bot-bot
# Cuando pregunte por template: Empty project
```

### 4.2 Conectar el repositorio de GitHub

```bash
# Dentro de la carpeta del proyecto
railway link
# Selecciona el proyecto que acabas de crear
```

**O desde la web:**

1. Ve a [railway.app](https://railway.app) → tu proyecto → **New Service**
2. Click **GitHub Repo**
3. Selecciona `madrid-temp-bot`
4. En **Root Directory** pon: `packages/bot`

### 4.3 Variables de entorno en Railway

En el dashboard de Railway → tu servicio → **Variables**, añade una a una:

```
SUPABASE_URL              =  https://xxxx.supabase.co
SUPABASE_SERVICE_KEY      =  eyJ...  (la service_role key — esta sí es secreta)
AEMET_API_KEY             =  (obtener en opendata.aemet.es)
VISUAL_CROSSING_KEY       =  (obtener en visualcrossing.com)
OPENWEATHER_API_KEY       =  (opcional por ahora)
ACCUWEATHER_API_KEY       =  (opcional por ahora)
WEATHERAPI_KEY            =  (opcional por ahora)
TOMORROW_IO_KEY           =  (opcional por ahora)
POLYMARKET_API_KEY        =  (obtener en polymarket.com)
POLYMARKET_PRIVATE_KEY    =  (solo necesario cuando LIVE_TRADING=true)
LIVE_TRADING              =  false
TZ                        =  Europe/Madrid
NODE_ENV                  =  production
```

> Las fuentes marcadas como "opcional" se pueden añadir después. El bot arrancará solo con Open-Meteo (gratuita, sin key) y las que tengas configuradas.

### 4.4 Configurar build y start

Railway debería detectar `railway.toml` automáticamente. Si no:

En Railway → tu servicio → **Settings**:

```
Build Command:  cd packages/bot && pnpm install && pnpm build
Start Command:  cd packages/bot && node dist/index.js
```

### 4.5 Deploy

```bash
# Desde terminal
railway up

# O simplemente haz push a GitHub:
git push origin main
# Railway detecta el push y redespliega automáticamente
```

### 4.6 Verificar que el bot está corriendo

```bash
# Ver logs en tiempo real
railway logs
```

Deberías ver:
```
🤖 Madrid Temp Bot iniciado
   Modo: 🟡 SIMULACIÓN
   Predicción diaria: 18:00 Europe/Madrid
```

---

## 5. Primer backtest manual

Con todo desplegado, lanza el backtest desde tu máquina local para validar la Fase 1:

```bash
# Instala dependencias
cd packages/bot
pnpm install

# Copia el .env
cp ../../.env.example ../../.env
# Edita .env con tus credenciales reales

# Lanza el backtest (usa Open-Meteo + Visual Crossing)
pnpm backtest
```

El resultado se guardará automáticamente en Supabase y aparecerá en el dashboard de Vercel en la página `/training`.

---

## 6. Verificación final

| Check | Cómo verificarlo |
|---|---|
| Supabase: tablas creadas | Table Editor → ver las 5 tablas |
| GitHub: código subido | github.com/TU_USUARIO/madrid-temp-bot |
| Vercel: dashboard online | URL de Vercel → página carga sin errores |
| Railway: bot corriendo | `railway logs` → sin errores de arranque |
| Backtest ejecutado | Dashboard → `/training` → aparece el primer run |

---

## 7. Flujo de trabajo diario (una vez todo en marcha)

```bash
# Desarrollar en local
git checkout -b feature/mi-mejora
# ... hacer cambios ...
git add . && git commit -m "feat: descripción"
git push origin feature/mi-mejora

# Merge a main → dispara redeploy automático en Vercel y Railway
git checkout main && git merge feature/mi-mejora
git push origin main
```

---

## Problemas frecuentes

**Vercel: "Could not find package.json"**
→ Asegúrate de que Root Directory está a `packages/dashboard`

**Railway: "Cannot find module"**  
→ Verifica que el Build Command incluye `pnpm install` antes de `pnpm build`

**Supabase: "permission denied for table"**  
→ Estás usando la `anon_key` donde debería ir la `service_role key`. El bot necesita la service key.

**Bot: fuente X falla al arrancar**  
→ Normal si no tienes todas las API keys. El ensemble ignora las fuentes que fallan y continúa con las disponibles. Revisa los logs con `railway logs`.
