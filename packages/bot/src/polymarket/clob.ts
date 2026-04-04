// src/polymarket/clob.ts
// Polymarket CLOB API — ejecución de órdenes reales
// ⚠️ Solo se usa cuando LIVE_TRADING=true
// Documentación: https://docs.polymarket.com/#clob
//
// Autenticación L2 con persistencia en Supabase (bot_config):
//
//   Las credenciales L2 (apiKey, secret, passphrase) se derivan UNA SOLA VEZ
//   desde la private key de la wallet y se almacenan en bot_config bajo la
//   clave 'clob_l2_credentials'. En reinicios del bot, se leen de allí sin
//   necesidad de volver a llamar a /auth/derive-api-key.
//
//   Flujo completo:
//     1. Al instanciar ClobClient, getCredentials() busca en bot_config.
//     2. Si existen → las usa directamente (sin llamada a Polymarket).
//     3. Si no existen → llama a /auth/derive-api-key, obtiene las creds,
//        las guarda en bot_config y las devuelve.
//     4. Cada request firma un mensaje fresco con timestamp + nonce aleatorio.
//     5. Las órdenes se firman con EIP-712 (typed data).
//     6. Si cualquier llamada devuelve 401 → limpia Supabase y re-deriva
//        automáticamente (self-healing ante revocaciones).

import axios from 'axios'
import crypto from 'crypto'
import { ethers } from 'ethers'
import { supabase } from '../db/supabase'

const CLOB_BASE          = 'https://clob.polymarket.com'
const SUPABASE_CREDS_KEY = 'clob_l2_credentials'  // clave en bot_config

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface OrderParams {
  tokenId: string      // ID del token YES en Polymarket (clobTokenIds[0])
  side: 'BUY'
  price: number        // 0.0 – 1.0
  size: number         // importe en USDC
}

export interface OrderResult {
  orderId: string
  status: 'matched' | 'open' | 'cancelled'
  filledSize: number
  price: number
}

interface L2Credentials {
  apiKey:        string
  apiSecret:     string
  apiPassphrase: string
  walletAddress: string  // guardamos la address para detectar cambio de wallet
  derivedAt:     string  // ISO timestamp — informativo
}

// ─── ClobClient ───────────────────────────────────────────────────────────────

export class ClobClient {
  private wallet: ethers.Wallet
  private memCache: L2Credentials | null = null  // caché en memoria (dentro de un run)

  constructor(
    private walletAddress: string,
    private privateKey: string
  ) {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
    this.wallet = new ethers.Wallet(normalizedKey)

    console.log('[CLOB] Wallet derivada de POLYMARKET_PRIVATE_KEY:', this.wallet.address)
    console.log('[CLOB] POLYMARKET_API_KEY (walletAddress param):  ', walletAddress)
    if (this.wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      console.error('[CLOB] ⚠️  MISMATCH — las addresses no coinciden, esto causará 401')
    } else {
      console.log('[CLOB] ✅ Addresses coinciden')
    }

    const envKey        = process.env.CLOB_API_KEY
    const envSecret     = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      console.log('[CLOB] 🔑 Credenciales L2 cargadas desde ENV vars:')
      console.log(`[CLOB]   CLOB_API_KEY        = ${envKey.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_SECRET      = ${envSecret.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_PASSPHRASE  = ${envPassphrase.substring(0, 8)}…`)
      this.memCache = {
        apiKey: envKey, apiSecret: envSecret, apiPassphrase: envPassphrase,
        walletAddress: this.wallet.address, derivedAt: 'env-var',
      }
    }
  }

  // ── getCredentials ────────────────────────────────────────────────────────
  // Prioridad: 1) caché en memoria → 2) Supabase → 3) derivar desde Polymarket

  private async getCredentials(): Promise<L2Credentials> {
    // 0. Env vars (máxima prioridad)
    const envKey = process.env.CLOB_API_KEY
    const envSecret = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      return { apiKey: envKey, apiSecret: envSecret, apiPassphrase: envPassphrase,
               walletAddress: this.wallet.address, derivedAt: 'env-var' }
    }

    // 1. Caché en memoria (evita una query a Supabase por cada orden en el mismo run)
    if (this.memCache && this.memCache.walletAddress === this.wallet.address) {
      return this.memCache
    }

    // 2. Intentar leer desde Supabase
    const fromDb = await this.loadFromSupabase()
    if (fromDb) {
      console.log(`[CLOB] Credenciales L2 cargadas desde Supabase (apiKey: ${fromDb.apiKey.substring(0, 8)}…)`)
      this.memCache = fromDb
      return fromDb
    }

    // 3. Derivar desde Polymarket y guardar en Supabase
    console.log('[CLOB] Sin credenciales L2 en Supabase — derivando desde private key…')
    const derived = await this.deriveAndPersist()
    this.memCache = derived
    return derived
  }

  // ── loadFromSupabase ──────────────────────────────────────────────────────

  private async loadFromSupabase(): Promise<L2Credentials | null> {
    try {
      const { data, error } = await supabase
        .from('bot_config')
        .select('value')
        .eq('key', SUPABASE_CREDS_KEY)
        .maybeSingle()

      if (error || !data) return null

      const creds = data.value as L2Credentials

      // Validar campos mínimos y que la wallet coincida
      // (por si el usuario cambió la private key)
      if (
        !creds?.apiKey ||
        !creds?.apiSecret ||
        !creds?.apiPassphrase ||
        creds.walletAddress?.toLowerCase() !== this.wallet.address.toLowerCase()
      ) {
        console.warn('[CLOB] Credenciales en Supabase inválidas o de otra wallet — re-derivando')
        return null
      }

      return creds
    } catch (err) {
      console.error('[CLOB] Error leyendo credenciales de Supabase:', (err as Error).message)
      return null
    }
  }

  // ── saveToSupabase ────────────────────────────────────────────────────────

  private async saveToSupabase(creds: L2Credentials): Promise<void> {
    try {
      const { error } = await supabase
        .from('bot_config')
        .upsert(
          {
            key:         SUPABASE_CREDS_KEY,
            value:       creds as unknown as Record<string, unknown>,
            description: `Credenciales L2 CLOB Polymarket para wallet ${creds.walletAddress}. Generadas automáticamente — NO editar manualmente.`,
            updated_at:  new Date().toISOString(),
          },
          { onConflict: 'key' }
        )

      if (error) {
        console.error('[CLOB] Error guardando credenciales en Supabase:', error.message)
      } else {
        console.log('[CLOB] ✅ Credenciales L2 persistidas en Supabase.')
      }
    } catch (err) {
      console.error('[CLOB] Excepción guardando en Supabase:', (err as Error).message)
    }
  }

  // ── clearSupabaseCredentials ──────────────────────────────────────────────
  // Borra las credenciales almacenadas para forzar re-derivación.
  // Se llama automáticamente tras un 401, o se puede invocar manualmente
  // si se sospecha que la API key fue revocada en Polymarket.

  async clearSupabaseCredentials(): Promise<void> {
    this.memCache = null
    try {
      await supabase
        .from('bot_config')
        .delete()
        .eq('key', SUPABASE_CREDS_KEY)
      console.log('[CLOB] Credenciales L2 eliminadas de Supabase — se re-derivarán en el próximo uso.')
    } catch (err) {
      console.error('[CLOB] Error eliminando credenciales de Supabase:', (err as Error).message)
    }
  }

  // ── deriveAndPersist ──────────────────────────────────────────────────────
  // Llama a /auth/derive-api-key (o GET si ya existe en Polymarket),
  // guarda el resultado en Supabase y lo devuelve.

  private async deriveAndPersist(): Promise<L2Credentials> {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce     = '0'  // nonce fijo requerido en la derivación L2

    const message   = `Polymarket CLOB API Key\ntimestamp: ${timestamp}\nnonce: ${nonce}`
    const signature = await this.wallet.signMessage(message)

    const derivationHeaders = {
      'Content-Type':   'application/json',
      'POLY_ADDRESS':   this.wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE':     nonce,
    }

    let rawCreds: { apiKey: string; secret: string; passphrase: string }

    try {
      const res = await axios.post(
        `${CLOB_BASE}/auth/derive-api-key`,
        {},
        { headers: derivationHeaders, timeout: 12_000 }
      )
      rawCreds = res.data

    } catch (err: any) {
      const status = err?.response?.status
      const body   = err?.response?.data

      // 400+"already exists" o 405 → key ya derivada, recuperar con GET
      const keyAlreadyExists =
        (status === 400 && JSON.stringify(body ?? '').toLowerCase().includes('already exists')) ||
        status === 405
      if (keyAlreadyExists) {
        console.log(`[CLOB] API key ya existía en Polymarket (HTTP ${status}) — recuperando con GET…`)
        const getRes = await axios.get(
          `${CLOB_BASE}/auth/derive-api-key`,
          { headers: derivationHeaders, timeout: 12_000 }
        )
        rawCreds = getRes.data
      } else {
        throw new Error(
          `[CLOB] Error en /auth/derive-api-key (HTTP ${status ?? 'network'}): ` +
          `${JSON.stringify(body) ?? err.message}`
        )
      }
    }

    const creds: L2Credentials = {
      apiKey:        rawCreds.apiKey,
      apiSecret:     rawCreds.secret,
      apiPassphrase: rawCreds.passphrase,
      walletAddress: this.wallet.address,
      derivedAt:     new Date().toISOString(),
    }

    console.log(`[CLOB] Credenciales L2 derivadas — apiKey: ${creds.apiKey.substring(0, 8)}…`)

    // Persistir en Supabase para los próximos reinicios del bot
    await this.saveToSupabase(creds)

    return creds
  }

  // ── buildAuthHeaders ──────────────────────────────────────────────────────
  // HMAC-SHA256(base64decode(secret), timestamp+METHOD+path+body)
  // Ref: py-clob-client → headers.py → create_level_2_headers

  private buildAuthHeaders(
    creds: L2Credentials,
    method: string,
    requestPath: string,
    body?: string,
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const msg       = timestamp + method.toUpperCase() + requestPath + (body ?? '')
    const secret    = Buffer.from(creds.apiSecret, 'base64')
    const signature = crypto.createHmac('sha256', secret).update(msg).digest('base64')

    return {
      'Content-Type':    'application/json',
      'POLY_ADDRESS':    this.wallet.address,
      'POLY_API_KEY':    creds.apiKey,
      'POLY_PASSPHRASE': creds.apiPassphrase,
      'POLY_SIGNATURE':  signature,
      'POLY_TIMESTAMP':  timestamp,
    }
  }

  // ── getBalance ────────────────────────────────────────────────────────────

  async getBalance(): Promise<number> {
    const creds   = await this.getCredentials()
    const headers = this.buildAuthHeaders(creds, 'GET', '/balance')
    const res     = await axios.get(`${CLOB_BASE}/balance`, { headers, timeout: 10_000 })
    return res.data.balance
  }

  // ── placeOrder ────────────────────────────────────────────────────────────
  // Coloca una orden limit de compra.
  // Auto-retry con re-derivación si recibe 401 (credenciales revocadas/expiradas).

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (process.env.LIVE_TRADING !== 'true') {
      throw new Error('ClobClient: LIVE_TRADING is not enabled — aborting real order')
    }

    try {
      return await this.doPlaceOrder(params)
    } catch (err: any) {
      const status = err?.response?.status ?? 0
      const is401  = status === 401 || String(err?.message ?? '').includes('401')

      if (is401) {
        console.warn('[CLOB] 401 recibido — limpiando credenciales y re-derivando…')
        await this.clearSupabaseCredentials()
        // Un solo reintento tras re-derivar
        return await this.doPlaceOrder(params)
      }

      throw err
    }
  }

  private async doPlaceOrder(params: OrderParams): Promise<OrderResult> {
    const creds     = await this.getCredentials()
    const orderData = await this.buildSignedOrder(params)
    const body      = JSON.stringify(orderData)
    const headers   = this.buildAuthHeaders(creds, 'POST', '/order', body)

    console.log('[CLOB] Enviando orden:', JSON.stringify(orderData, null, 2))

    try {
      const res = await axios.post(`${CLOB_BASE}/order`, orderData, { headers, timeout: 15_000 })
      return {
        orderId:    res.data.orderID    ?? res.data.orderId ?? 'unknown',
        status:     res.data.status     ?? 'open',
        filledSize: res.data.filledSize ?? 0,
        price:      res.data.price      ?? params.price,
      }
    } catch (err: any) {
      console.error('[CLOB] Error POST /order — response body:', JSON.stringify(err?.response?.data))
      throw err
    }
  }

  // ── buildSignedOrder ──────────────────────────────────────────────────────
  // Construye y firma la orden con EIP-712 (typed data).
  // Ref: https://docs.polymarket.com/#order-structure

  private async buildSignedOrder(params: OrderParams): Promise<object> {
    const salt = Math.floor(Math.random() * 1_000_000_000_000).toString()

    // Convertir USDC a unidades base (USDC en Polygon usa 6 decimales)
    const makerAmountRaw = Math.round(params.size * 1e6)
    const takerAmountRaw = Math.round((params.size / params.price) * 1e6)

    // Estructura de la orden (strings para el body del request)
    const orderStruct = {
      salt:          salt,
      maker:         this.wallet.address,
      signer:        this.wallet.address,
      taker:         '0x0000000000000000000000000000000000000000',
      tokenId:       params.tokenId,
      makerAmount:   makerAmountRaw.toString(),
      takerAmount:   takerAmountRaw.toString(),
      expiration:    '0',
      nonce:         '0',
      feeRateBps:    '0',
      side:          (params.side === 'BUY' ? 0 : 1).toString(),
      signatureType: '0',  // EOA (Externally Owned Account)
    }

    // Dominio EIP-712 del CTF Exchange de Polymarket en Polygon mainnet
    const domain = {
      name:              'CTF Exchange',
      version:           '1',
      chainId:           137,
      verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    }

    const types = {
      Order: [
        { name: 'salt',          type: 'uint256' },
        { name: 'maker',         type: 'address' },
        { name: 'signer',        type: 'address' },
        { name: 'taker',         type: 'address' },
        { name: 'tokenId',       type: 'uint256' },
        { name: 'makerAmount',   type: 'uint256' },
        { name: 'takerAmount',   type: 'uint256' },
        { name: 'expiration',    type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
        { name: 'feeRateBps',    type: 'uint256' },
        { name: 'side',          type: 'uint256' },
        { name: 'signatureType', type: 'uint256' },
      ],
    }

    // Valores como BigInt para signTypedData de ethers v6
    const orderForSigning = {
      salt:          BigInt(salt),
      maker:         this.wallet.address,
      signer:        this.wallet.address,
      taker:         '0x0000000000000000000000000000000000000000' as `0x${string}`,
      tokenId:       BigInt(params.tokenId),
      makerAmount:   BigInt(makerAmountRaw),
      takerAmount:   BigInt(takerAmountRaw),
      expiration:    BigInt(0),
      nonce:         BigInt(0),
      feeRateBps:    BigInt(0),
      side:          params.side === 'BUY' ? 0 : 1,
      signatureType: 0,
    }

    const signature = await this.wallet.signTypedData(domain, types, orderForSigning)

    return {
      order: {
        ...orderStruct,
        signature,
      },
      owner:     this.wallet.address,
      orderType: 'GTC',  // Good Till Cancelled
    }
  }

  // ── getOrder ──────────────────────────────────────────────────────────────

  async getOrder(orderId: string): Promise<OrderResult> {
    const creds   = await this.getCredentials()
    const headers = this.buildAuthHeaders(creds, 'GET', `/order/${orderId}`)

    const res = await axios.get(
      `${CLOB_BASE}/order/${orderId}`,
      { headers, timeout: 10_000 }
    )

    return {
      orderId:    res.data.id,
      status:     res.data.status,
      filledSize: res.data.filledSize ?? 0,
      price:      res.data.price ?? 0,
    }
  }
}
