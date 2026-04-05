// src/polymarket/clob.ts
// Polymarket CLOB API — ejecución de órdenes reales
// ⚠️  Solo se usa cuando LIVE_TRADING=true
//
// ────────────────────────────────────────────────────────────────────────────
// IMPLEMENTACIÓN NATIVA — sin SDK JS (@polymarket/clob-client)
//
// El SDK JS tiene incompatibilidades de firma EIP-712 con ethers v6 que
// producen "invalid signature" incluso con el workaround del EIP712Domain.
//
// Esta implementación replica exactamente lo que hace el SDK Python
// (py_clob_client) que SÍ funciona:
//   1. Construye el struct de la orden (mismos campos que OrderArgs de Python)
//   2. Firma con EIP-712 usando ethers v6 directamente (sin SDK)
//   3. POST a /order con HMAC-SHA256 en los headers L2
//
// El dominio EIP-712 y el struct "Order" son idénticos a los del SDK Python.
// ────────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers'
import { createHmac } from 'crypto'
import { supabase } from '../db/supabase'

const CLOB_HOST          = 'https://clob.polymarket.com'
const CHAIN_ID           = 137                    // Polygon
const SUPABASE_CREDS_KEY = 'clob_l2_credentials'

// ─── EIP-712 ──────────────────────────────────────────────────────────────────
// ATENCIÓN: 'ClobAuthDomain' es para /auth/api-key (L1 auth) ÚNICAMENTE.
// Las ÓRDENES usan el nombre del contrato CTF Exchange — igual que py-clob-client:
//   signing/eip712.py → CTF_EXCHANGE_DOMAIN_NAME / NEG_RISK_EXCHANGE_DOMAIN_NAME
// El dominio completo se construye en placeOrder() porque depende de negRisk.

const CTF_EXCHANGE_DOMAIN_NAME      = 'Polymarket CTF Exchange'
const NEG_RISK_EXCHANGE_DOMAIN_NAME = 'Polymarket NegRisk CTF Exchange'

// Tipos para la orden — idénticos a OrderData en py-clob-client
const ORDER_TYPES = {
  Order: [
    { name: 'salt',        type: 'uint256' },
    { name: 'maker',       type: 'address' },
    { name: 'signer',      type: 'address' },
    { name: 'taker',       type: 'address' },
    { name: 'tokenId',     type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration',  type: 'uint256' },
    { name: 'nonce',       type: 'uint256' },
    { name: 'feeRateBps',  type: 'uint256' },
    { name: 'side',        type: 'uint8'   },
    { name: 'signatureType', type: 'uint8' },
  ],
}

// ─── Contratos Polymarket (Polygon mainnet) ───────────────────────────────────
// Fuente: py-clob-client contracts.py
const COLLATERAL_TOKEN  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // USDC.e
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' // neg_risk=false
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a' // neg_risk=true
const NEG_RISK_ADAPTER  = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface OrderParams {
  tokenId:  string
  side:     'BUY'
  price:    number   // 0.0 – 1.0
  size:     number   // importe en USDC (igual que Python: stake_usdc)
  negRisk?: boolean
}

export interface OrderResult {
  orderId:    string
  status:     string
  filledSize: number
  price:      number
}

interface L2Credentials {
  apiKey:        string
  apiSecret:     string
  apiPassphrase: string
  walletAddress: string
  derivedAt:     string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Precio en USDC (6 decimales) → uint256 en unidades micro */
function toMicroUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

/** Convierte shares a uint256 (6 decimales, mismo que USDC para tokens Polymarket) */
function toShares(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000))
}

/** HMAC-SHA256 para headers L2 — replica exactamente py-clob-client/signing/hmac.py
 *
 * Python: base64.urlsafe_b64decode(secret) → hmac-sha256 → base64.urlsafe_b64encode
 * Headers con underscore: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE
 */
function buildL2Headers(
  creds:     L2Credentials,
  method:    string,
  path:      string,
  body:      string,
  timestamp: number,
): Record<string, string> {
  // urlsafe base64 decode del secret (igual que Python: base64.urlsafe_b64decode)
  const secretBytes = Buffer.from(creds.apiSecret.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

  // mensaje = timestamp + METHOD_UPPER + path [+ body si no vacío]
  const message = body
    ? `${timestamp}${method.toUpperCase()}${path}${body}`
    : `${timestamp}${method.toUpperCase()}${path}`

  const hmac = createHmac('sha256', secretBytes)
  hmac.update(message)

  // urlsafe base64 encode del digest (igual que Python: base64.urlsafe_b64encode)
  const signature = hmac.digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return {
    'POLY_ADDRESS':    creds.walletAddress,
    'POLY_SIGNATURE':  signature,
    'POLY_TIMESTAMP':  String(timestamp),
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.apiPassphrase,
  }
}

// ─── ClobClient ───────────────────────────────────────────────────────────────

export class ClobClient {
  private wallet:   ethers.Wallet
  private memCache: L2Credentials | null = null

  constructor(
    private walletAddress: string,
    private privateKey:    string,
  ) {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
    this.wallet = new ethers.Wallet(normalizedKey)

    console.log('[CLOB] Wallet derivada de POLYMARKET_PRIVATE_KEY:', this.wallet.address)
    console.log('[CLOB] POLYMARKET_API_KEY (walletAddress param):  ', walletAddress)
    if (this.wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      console.error('[CLOB] ⚠️  MISMATCH — addresses no coinciden, revisad las env vars')
    } else {
      console.log('[CLOB] ✅ Addresses coinciden')
    }

    // Pre-cargar credenciales L2 desde env si están disponibles
    const envKey        = process.env.CLOB_API_KEY
    const envSecret     = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      console.log('[CLOB] 🔑 Credenciales L2 desde ENV vars:')
      console.log(`[CLOB]   CLOB_API_KEY       = ${envKey.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_SECRET     = ${envSecret.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_PASSPHRASE = ${envPassphrase.substring(0, 8)}…`)
      this.memCache = {
        apiKey:        envKey,
        apiSecret:     envSecret,
        apiPassphrase: envPassphrase,
        walletAddress: this.wallet.address,
        derivedAt:     'env-var',
      }
    }
  }

  // ── placeOrder ────────────────────────────────────────────────────────────
  //
  // Replica exactamente client.create_and_post_order(OrderArgs(...)) de Python:
  //   1. Calcula makerAmount / takerAmount según side
  //   2. Firma con EIP-712 (signTypedData de ethers v6, SIN SDK JS)
  //   3. POST /order con headers HMAC L2

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (process.env.LIVE_TRADING !== 'true') {
      throw new Error('ClobClient: LIVE_TRADING is not enabled — aborting real order')
    }

    const creds   = await this.getCredentials()
    const negRisk = params.negRisk ?? await this.getNegRisk(params.tokenId)

    // ── 1. Fetch feeRateBps dinámico desde /fee-rate ──────────────────────
    // CRÍTICO: desde 2026, weather markets también tienen fees.
    // Si feeRateBps no coincide con el valor del servidor → Invalid order payload
    // Docs: GET https://clob.polymarket.com/fee-rate?token_id={token_id}
    const feeRateBpsInt = await this.getFeeRate(params.tokenId)
    const feeRateBps    = BigInt(feeRateBpsInt)
    console.log(`[CLOB] feeRateBps=${feeRateBpsInt} para token ${params.tokenId.substring(0, 16)}…`)

    // ── 2. Calcular amounts ───────────────────────────────────────────────
    // BUY: makerAmount = USDC a gastar, takerAmount = shares a recibir
    // Python: size = stake / price  (en units de token)
    const sharesFloat  = params.size / params.price    // shares = usdc / price
    const makerAmount  = toMicroUsdc(params.size)      // USDC que pones
    const takerAmount  = toShares(sharesFloat)         // tokens que recibes

    console.log(
      `[CLOB] Colocando orden: price=${params.price} | usdc=${params.size} | ` +
      `shares=${sharesFloat.toFixed(4)} | negRisk=${negRisk} | feeRateBps=${feeRateBpsInt}`
    )
    console.log(`[CLOB] makerAmount=${makerAmount} | takerAmount=${takerAmount}`)

    // ── 3. Construir struct EIP-712 de la orden ───────────────────────────
    // Igual que OrderData en py-clob-client/signing/model.py
    const salt       = BigInt(Math.floor(Math.random() * 1_000_000_000_000))
    const expiration = BigInt(0)    // GTC (no expira)
    const nonce      = BigInt(0)
    const sideValue  = BigInt(0)    // 0 = BUY
    const sigType    = BigInt(1)    // 1 = POLY_PROXY (signature_type en Python)

    const exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE
    const taker    = negRisk ? NEG_RISK_ADAPTER  : ethers.ZeroAddress

    const orderStruct = {
      salt:          salt,
      maker:         this.wallet.address,
      signer:        this.wallet.address,
      taker:         taker,
      tokenId:       BigInt(params.tokenId),
      makerAmount:   makerAmount,
      takerAmount:   takerAmount,
      expiration:    expiration,
      nonce:         nonce,
      feeRateBps:    feeRateBps,      // ← valor real del servidor
      side:          sideValue,
      signatureType: sigType,
    }

    // ── 4. Firmar con EIP-712 (ethers v6 nativo, sin SDK JS) ─────────────
    // El nombre del dominio varía por negRisk — igual que py-clob-client/signing/eip712.py
    const domain = {
      name:              negRisk ? NEG_RISK_EXCHANGE_DOMAIN_NAME : CTF_EXCHANGE_DOMAIN_NAME,
      version:           '1',
      chainId:           CHAIN_ID,
      verifyingContract: exchange,
    }

    let signature: string
    try {
      signature = await this.wallet.signTypedData(domain, ORDER_TYPES, orderStruct)
      console.log('[CLOB] Orden firmada correctamente')
    } catch (err) {
      console.error('[CLOB] Error firmando orden:', err)
      throw err
    }

    // ── 5. Construir payload JSON para POST /order ────────────────────────
    // Replica exactamente order_to_json() de py-clob-client/order_builder.py:
    //   - salt:          int(order.salt)   → número JSON  (no string)
    //   - side:          order.side        → "BUY" string (no número 0)
    //   - signatureType: int               → número JSON  ✓ (ya estaba bien)
    // Outer body añade 'owner' (maker address) — campo requerido por el servidor.
    const orderPayload = {
      salt:          Number(salt),             // número JSON, igual que Python int(order.salt)
      maker:         this.wallet.address,
      signer:        this.wallet.address,
      taker:         taker,
      tokenId:       params.tokenId,
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    expiration.toString(),
      nonce:         nonce.toString(),
      feeRateBps:    feeRateBps.toString(),
      side:          'BUY',                    // string, igual que Python SignedOrder.side
      signatureType: 1,
      signature,
    }

    // ── 6. Owner address: proxy wallet, NO el EOA ────────────────────────
    // En Polymarket POLY_PROXY (signature_type=1):
    //   - maker/signer en EIP-712 = EOA (quien firma con la private key)
    //   - owner en el body REST   = proxy wallet (la cuenta Polymarket real)
    // Python equivalente: cfg["polymarket"]["funder"] = proxy wallet address
    // → Configura POLYMARKET_FUNDER en Railway con tu proxy wallet address.
    const ownerAddress = await this.resolveOwnerAddress(creds)

    const bodyObj = {
      order:     orderPayload,
      owner:     ownerAddress,
      orderType: 'GTC',
      negRisk,
    }
    const body      = JSON.stringify(bodyObj)
    const path      = '/order'
    const timestamp = Math.floor(Date.now() / 1000)

    const l2Headers = buildL2Headers(creds, 'POST', path, body, timestamp)

    // ── 7. Log completo del payload para debug ────────────────────────────
    console.log('[CLOB] ── PAYLOAD ───────────────────────────────────────')
    console.log('[CLOB] domain: ' + JSON.stringify({ name: domain.name, verifyingContract: exchange }))
    console.log('[CLOB] owner:  ' + ownerAddress + ' | EOA: ' + this.wallet.address)
    console.log('[CLOB] body:   ' + body)
    console.log('[CLOB] ─────────────────────────────────────────────────')
    console.log('[CLOB] Enviando orden al CLOB REST API…')
    let res: Response
    try {
      res = await fetch(`${CLOB_HOST}${path}`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...l2Headers,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('[CLOB] Error de red al enviar orden:', err)
      throw err
    }

    const text = await res.text()
    console.log(`[CLOB] Respuesta HTTP ${res.status}: ${text}`)

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`[CLOB] Respuesta no-JSON del servidor (HTTP ${res.status}): ${text}`)
    }

    if (data?.error || !res.ok) {
      throw new Error(`[CLOB] Rechazada por el servidor: ${data?.error ?? text}`)
    }

    const orderId = data?.orderID ?? data?.id ?? data?.hash ?? 'unknown'
    return {
      orderId,
      status:     data?.status     ?? 'open',
      filledSize: parseFloat(data?.sizeFilled ?? data?.size_filled ?? '0'),
      price:      params.price,
    }
  }

  // ── getNegRisk ────────────────────────────────────────────────────────────
  // Consulta si el token es negRisk via REST (igual que Python)

  async getNegRisk(tokenId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${CLOB_HOST}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`,
        { signal: AbortSignal.timeout(8_000) }
      )
      if (!res.ok) return false
      const data = await res.json() as any
      const markets: any[] = Array.isArray(data) ? data : (data?.data ?? [])
      return !!markets[0]?.neg_risk
    } catch {
      return false
    }
  }

  // ── resolveOwnerAddress ──────────────────────────────────────────────────
  // Devuelve el 'owner' correcto para el body de POST /order.
  //
  // En Polymarket POLY_PROXY (signature_type=1), el 'owner' NO es el EOA sino
  // la proxy wallet (contrato desplegado por Polymarket para tu cuenta).
  // Python: cfg["polymarket"]["funder"] = proxy wallet address.
  //
  // Prioridad:
  //   1. POLYMARKET_FUNDER env var  ← configura en Railway
  //   2. Auto-discovery via GET /auth/api-key
  //   3. EOA como fallback (loguea advertencia)

  private ownerAddressCache: string | null = null

  async resolveOwnerAddress(creds: L2Credentials): Promise<string> {
    // 1. Env var explícita (equivalente a funder en Python)
    if (process.env.POLYMARKET_FUNDER) {
      const addr = process.env.POLYMARKET_FUNDER.trim()
      console.log(`[CLOB] owner → POLYMARKET_FUNDER: ${addr}`)
      return addr
    }

    // 2. Caché en memoria
    if (this.ownerAddressCache) return this.ownerAddressCache

    // 3. Auto-discovery: GET /auth/api-key con L2 headers
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const l2Headers = buildL2Headers(creds, 'GET', '/auth/api-key', '', timestamp)
      const res = await fetch(`${CLOB_HOST}/auth/api-key`, {
        headers: l2Headers,
        signal:  AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        const data: any = await res.json()
        const discovered = data?.funder ?? data?.address ?? data?.proxyWallet ?? null
        if (discovered && ethers.isAddress(discovered)) {
          console.log(`[CLOB] owner → auto-discovery: ${discovered}`)
          this.ownerAddressCache = discovered
          return discovered
        }
        // Log completo para que puedas ver qué devuelve y encontrar el campo correcto
        console.log('[CLOB] /auth/api-key raw (para diagnóstico):', JSON.stringify(data))
      }
    } catch (err: any) {
      console.warn('[CLOB] Auto-discovery owner fallida:', err?.message)
    }

    // 4. Fallback al EOA
    console.warn('[CLOB] ⚠️  No se resolvió proxy wallet — usando EOA como owner.')
    console.warn('[CLOB]    Si falla: añade POLYMARKET_FUNDER=<proxy_wallet> en Railway.')
    console.warn('[CLOB]    La proxy wallet = cfg["polymarket"]["funder"] en el bot Python.')
    return this.wallet.address
  }

  // ── getFeeRate ────────────────────────────────────────────────────────────
  // GET /fee-rate?token_id=... → devuelve el feeRateBps actual del mercado.
  // CRÍTICO: debe incluirse en el payload firmado. 0 para mercados sin fee.
  // Docs: https://docs.polymarket.com/trading/fees

  async getFeeRate(tokenId: string): Promise<number> {
    try {
      const res = await fetch(
        `${CLOB_HOST}/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
        { signal: AbortSignal.timeout(8_000) }
      )
      if (!res.ok) {
        console.warn(`[CLOB] /fee-rate respondió ${res.status} — usando feeRateBps=0`)
        return 0
      }
      const data = await res.json() as any
      // Respuesta: { "fee_rate_bps": "0" } o { "fee_rate_bps": "100" }
      const rate = parseInt(data?.fee_rate_bps ?? data?.feeRateBps ?? '0', 10)
      return isNaN(rate) ? 0 : rate
    } catch (err) {
      console.warn('[CLOB] No se pudo consultar fee-rate:', err, '— usando 0')
      return 0
    }
  }

  // ── getBalance ────────────────────────────────────────────────────────────

  async getBalance(): Promise<number> {
    const creds     = await this.getCredentials()
    // El HMAC se firma sobre el path SIN query params (igual que py-clob-client)
    const signPath  = '/balance-allowance'
    const fullPath  = '/balance-allowance?asset_type=COLLATERAL&signature_type=1'
    const timestamp = Math.floor(Date.now() / 1000)
    const l2Headers = buildL2Headers(creds, 'GET', signPath, '', timestamp)

    try {
      const res  = await fetch(`${CLOB_HOST}${fullPath}`, {
        headers: l2Headers,
        signal:  AbortSignal.timeout(8_000),
      })
      const data = await res.json() as any
      const balance = parseFloat(data?.balance ?? '0')
      console.log(`[CLOB] Balance USDC: ${balance.toFixed(4)} (raw: ${JSON.stringify(data)})`)
      return balance
    } catch (err) {
      console.warn('[CLOB] No se pudo consultar balance:', err)
      return 0
    }
  }

  // ── getCredentials ────────────────────────────────────────────────────────

  private async getCredentials(): Promise<L2Credentials> {
    // 1. ENV vars (máxima prioridad)
    const envKey        = process.env.CLOB_API_KEY
    const envSecret     = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      return {
        apiKey:        envKey,
        apiSecret:     envSecret,
        apiPassphrase: envPassphrase,
        walletAddress: this.wallet.address,
        derivedAt:     'env-var',
      }
    }

    // 2. Caché en memoria
    if (this.memCache && this.memCache.walletAddress === this.wallet.address) {
      return this.memCache
    }

    // 3. Supabase
    const fromDb = await this.loadFromSupabase()
    if (fromDb) {
      console.log(`[CLOB] Credenciales L2 desde Supabase (apiKey: ${fromDb.apiKey.substring(0, 8)}…)`)
      this.memCache = fromDb
      return fromDb
    }

    // 4. Derivar
    console.log('[CLOB] Sin credenciales L2 — derivando desde private key…')
    const derived = await this.deriveCredentials()
    this.memCache = derived
    return derived
  }

  // ── deriveCredentials ─────────────────────────────────────────────────────
  // Deriva credenciales L2 via POST /auth/api-key con firma EIP-712
  // Igual que ClobClient.create_or_derive_api_key() en Python

  private async deriveCredentials(): Promise<L2Credentials> {
    const timestamp = Math.floor(Date.now() / 1000)
    const message   = `${timestamp}GET/auth/api-key`

    const domain = {
      name:    'ClobAuthDomain',
      version: '1',
      chainId: CHAIN_ID,
    }
    const authTypes = {
      ClobAuth: [
        { name: 'address',   type: 'address' },
        { name: 'timestamp', type: 'string'  },
        { name: 'nonce',     type: 'uint256' },
        { name: 'message',   type: 'string'  },
      ],
    }
    const authValue = {
      address:   this.wallet.address,
      timestamp: String(timestamp),
      nonce:     0,
      message:   'This message attests that I have read and agree to the terms of service.',
    }

    const sig = await this.wallet.signTypedData(domain, authTypes, authValue)

    const res  = await fetch(`${CLOB_HOST}/auth/api-key`, {
      method:  'GET',
      headers: {
        'POLY-ADDRESS':   this.wallet.address,
        'POLY-SIGNATURE': sig,
        'POLY-TIMESTAMP': String(timestamp),
        'POLY-NONCE':     '0',
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`[CLOB] Error derivando credenciales (HTTP ${res.status}): ${text}`)
    }

    const data: any = await res.json()
    const creds: L2Credentials = {
      apiKey:        data.apiKey        ?? data.key,
      apiSecret:     data.secret,
      apiPassphrase: data.passphrase,
      walletAddress: this.wallet.address,
      derivedAt:     new Date().toISOString(),
    }

    console.log(`[CLOB] ✅ Credenciales derivadas — apiKey: ${creds.apiKey.substring(0, 8)}…`)
    await this.saveToSupabase(creds)
    return creds
  }

  // ── Supabase helpers ──────────────────────────────────────────────────────

  private async loadFromSupabase(): Promise<L2Credentials | null> {
    try {
      const { data, error } = await supabase
        .from('bot_config')
        .select('value')
        .eq('key', SUPABASE_CREDS_KEY)
        .maybeSingle()
      if (error || !data) return null
      const creds = data.value as L2Credentials
      if (
        !creds?.apiKey || !creds?.apiSecret || !creds?.apiPassphrase ||
        creds.walletAddress?.toLowerCase() !== this.wallet.address.toLowerCase()
      ) {
        console.warn('[CLOB] Credenciales en Supabase inválidas o de otra wallet')
        return null
      }
      return creds
    } catch (err) {
      console.error('[CLOB] Error leyendo Supabase:', (err as Error).message)
      return null
    }
  }

  private async saveToSupabase(creds: L2Credentials): Promise<void> {
    try {
      const { error } = await supabase.from('bot_config').upsert(
        {
          key:         SUPABASE_CREDS_KEY,
          value:       creds as unknown as Record<string, unknown>,
          description: `Credenciales L2 CLOB para wallet ${creds.walletAddress}. NO editar manualmente.`,
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'key' }
      )
      if (error) console.error('[CLOB] Error guardando en Supabase:', error.message)
      else        console.log('[CLOB] ✅ Credenciales L2 persistidas en Supabase.')
    } catch (err) {
      console.error('[CLOB] Excepción guardando en Supabase:', (err as Error).message)
    }
  }

  async clearSupabaseCredentials(): Promise<void> {
    this.memCache = null
    try {
      await supabase.from('bot_config').delete().eq('key', SUPABASE_CREDS_KEY)
      console.log('[CLOB] Credenciales L2 eliminadas de Supabase.')
    } catch (err) {
      console.error('[CLOB] Error eliminando credenciales:', (err as Error).message)
    }
  }
}
