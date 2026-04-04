// src/polymarket/clob.ts
// Polymarket CLOB API — ejecución de órdenes reales
// ⚠️  Solo se usa cuando LIVE_TRADING=true
//
// Usa el SDK oficial @polymarket/clob-client para firmar órdenes,
// eliminando la necesidad de implementar EIP-712 / HMAC manualmente.
//
// Credenciales L2 (apiKey, secret, passphrase):
//   Prioridad: ENV vars (CLOB_API_KEY/SECRET/PASSPHRASE) → Supabase → derivación

import { ClobClient as PolyClobClient, Side, OrderType, Chain, AssetType } from '@polymarket/clob-client'
import { ethers } from 'ethers'
import { supabase } from '../db/supabase'

const CLOB_HOST          = 'https://clob.polymarket.com'
const SUPABASE_CREDS_KEY = 'clob_l2_credentials'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface OrderParams {
  tokenId:  string   // clobTokenIds del mercado Polymarket
  side:     'BUY'
  price:    number   // 0.0 – 1.0
  size:     number   // importe en USDC
  negRisk?: boolean  // true para mercados Neg Risk (la mayoría de los nuevos)
}

export interface OrderResult {
  orderId:    string
  status:     'matched' | 'open' | 'cancelled'
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

// ─── ClobClient ───────────────────────────────────────────────────────────────

export class ClobClient {
  private wallet:   ethers.Wallet
  private memCache: L2Credentials | null = null

  constructor(
    private walletAddress: string,
    private privateKey:    string
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

    const envKey        = process.env.CLOB_API_KEY
    const envSecret     = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      console.log('[CLOB] 🔑 Credenciales L2 desde ENV vars:')
      console.log(`[CLOB]   CLOB_API_KEY        = ${envKey.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_SECRET      = ${envSecret.substring(0, 8)}…`)
      console.log(`[CLOB]   CLOB_API_PASSPHRASE  = ${envPassphrase.substring(0, 8)}…`)
      this.memCache = {
        apiKey: envKey, apiSecret: envSecret, apiPassphrase: envPassphrase,
        walletAddress: this.wallet.address, derivedAt: 'env-var',
      }
    }
  }

  // ── ethersSigner ─────────────────────────────────────────────────────────
  // El SDK espera la interfaz ethers v5 (_signTypedData + getAddress).
  // Adaptamos ethers v6 (signTypedData) para que sea compatible.

  private get ethersSigner() {
    return {
      _signTypedData: (domain: any, types: any, value: any) =>
        this.wallet.signTypedData(domain, types, value),
      getAddress: () => Promise.resolve(this.wallet.address),
    }
  }

  // ── getCredentials ────────────────────────────────────────────────────────

  private async getCredentials(): Promise<L2Credentials> {
    const envKey        = process.env.CLOB_API_KEY
    const envSecret     = process.env.CLOB_API_SECRET
    const envPassphrase = process.env.CLOB_API_PASSPHRASE
    if (envKey && envSecret && envPassphrase) {
      return {
        apiKey: envKey, apiSecret: envSecret, apiPassphrase: envPassphrase,
        walletAddress: this.wallet.address, derivedAt: 'env-var',
      }
    }

    if (this.memCache && this.memCache.walletAddress === this.wallet.address) {
      return this.memCache
    }

    const fromDb = await this.loadFromSupabase()
    if (fromDb) {
      console.log(`[CLOB] Credenciales L2 desde Supabase (apiKey: ${fromDb.apiKey.substring(0, 8)}…)`)
      this.memCache = fromDb
      return fromDb
    }

    console.log('[CLOB] Sin credenciales L2 — derivando desde private key…')
    const derived = await this.deriveAndPersist()
    this.memCache = derived
    return derived
  }

  // ── buildPolyClient ───────────────────────────────────────────────────────

  private async buildPolyClient(): Promise<PolyClobClient> {
    const creds = await this.getCredentials()
    return new PolyClobClient(
      CLOB_HOST,
      Chain.POLYGON,
      this.ethersSigner,
      {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      }
    )
  }

  // ── placeOrder ────────────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (process.env.LIVE_TRADING !== 'true') {
      throw new Error('ClobClient: LIVE_TRADING is not enabled — aborting real order')
    }

    // El SDK trabaja en shares (tokens), no en USDC
    const sizeInShares = params.size / params.price

    console.log(
      `[CLOB] Colocando orden: price=${params.price} | usdc=${params.size} | ` +
      `shares=${sizeInShares.toFixed(4)} | negRisk=${params.negRisk ?? 'auto'}`
    )

    const client = await this.buildPolyClient()

    // ── Diagnóstico de balance (solo log, no bloquea la orden) ──────────────
    // getBalanceAllowance refleja la allowance on-chain del CTF Exchange,
    // que puede devolver 0 aunque haya USDC disponible para operar.
    // Si realmente no hay fondos, el CLOB rechazará la orden con su propio error.
    try {
      const balRes    = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      const balance   = parseFloat((balRes as any)?.balance   ?? '0')
      const allowance = parseFloat((balRes as any)?.allowance ?? '0')
      console.log(`[CLOB] Balance USDC: ${balance.toFixed(4)} | Allowance: ${allowance.toFixed(4)} | Necesario: ${params.size.toFixed(4)}`)
    } catch (err: any) {
      console.warn('[CLOB] No se pudo consultar balance:', err?.message)
    }

    // ── negRisk ───────────────────────────────────────────────────────────
    let negRisk = params.negRisk
    if (negRisk === undefined) {
      try {
        negRisk = await client.getNegRisk(params.tokenId)
        console.log(`[CLOB] negRisk detectado: ${negRisk}`)
      } catch {
        negRisk = false
        console.warn('[CLOB] No se pudo detectar negRisk, usando false')
      }
    }

    try {
      const signedOrder = await client.createOrder(
        { tokenID: params.tokenId, price: params.price, size: sizeInShares, side: Side.BUY },
        { negRisk }
      )

      console.log('[CLOB] Orden firmada, enviando…')
      const res = await client.postOrder(signedOrder, OrderType.GTC)
      console.log('[CLOB] Respuesta:', JSON.stringify(res))

      const orderId = res?.orderID ?? res?.orderId ?? res?.hash ?? 'unknown'
      return {
        orderId,
        status:     res?.status     ?? 'open',
        filledSize: res?.filledSize ?? 0,
        price:      params.price,
      }
    } catch (err: any) {
      const status = err?.response?.status
      const body   = err?.response?.data
      console.error(`[CLOB] Error placeOrder (HTTP ${status ?? '?'}):`, JSON.stringify(body ?? err?.message))
      throw err
    }
  }

  // ── getBalance ────────────────────────────────────────────────────────────
  // FIX: pasar { assetType: AssetType.COLLATERAL } para leer el saldo USDC.
  // Sin este parámetro getBalanceAllowance() devuelve 0 aunque haya fondos.

  async getBalance(): Promise<number> {
    const client = await this.buildPolyClient()
    const res    = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
    const balance = parseFloat((res as any)?.balance ?? '0')
    console.log(`[CLOB] getBalance(): ${balance.toFixed(4)} USDC (raw: ${JSON.stringify(res)})`)
    return balance
  }

  // ── getOrder ──────────────────────────────────────────────────────────────

  async getOrder(orderId: string): Promise<OrderResult> {
    const client = await this.buildPolyClient()
    const res    = await client.getOrder(orderId)
    return {
      orderId:    (res as any).id,
      status:     (res as any).status as OrderResult['status'],
      filledSize: (res as any).size_matched ? parseFloat((res as any).size_matched) : 0,
      price:      (res as any).price ? parseFloat((res as any).price) : 0,
    }
  }

  // ── clearSupabaseCredentials ──────────────────────────────────────────────

  async clearSupabaseCredentials(): Promise<void> {
    this.memCache = null
    try {
      await supabase.from('bot_config').delete().eq('key', SUPABASE_CREDS_KEY)
      console.log('[CLOB] Credenciales L2 eliminadas de Supabase.')
    } catch (err) {
      console.error('[CLOB] Error eliminando credenciales:', (err as Error).message)
    }
  }

  // ── loadFromSupabase ──────────────────────────────────────────────────────

  private async loadFromSupabase(): Promise<L2Credentials | null> {
    try {
      const { data, error } = await supabase
        .from('bot_config').select('value').eq('key', SUPABASE_CREDS_KEY).maybeSingle()

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

  // ── saveToSupabase ────────────────────────────────────────────────────────

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
      if (error) { console.error('[CLOB] Error guardando en Supabase:', error.message) }
      else        { console.log('[CLOB] ✅ Credenciales L2 persistidas en Supabase.') }
    } catch (err) {
      console.error('[CLOB] Excepción guardando en Supabase:', (err as Error).message)
    }
  }

  // ── deriveAndPersist ──────────────────────────────────────────────────────

  private async deriveAndPersist(): Promise<L2Credentials> {
    const tempClient = new PolyClobClient(CLOB_HOST, Chain.POLYGON, this.ethersSigner)

    let rawCreds: { key: string; secret: string; passphrase: string }
    try {
      rawCreds = await tempClient.createOrDeriveApiKey()
    } catch (err: any) {
      console.error('[CLOB] Error derivando API key:', err?.message)
      throw err
    }

    const creds: L2Credentials = {
      apiKey:        rawCreds.key,
      apiSecret:     rawCreds.secret,
      apiPassphrase: rawCreds.passphrase,
      walletAddress: this.wallet.address,
      derivedAt:     new Date().toISOString(),
    }

    console.log(`[CLOB] ✅ Credenciales derivadas — apiKey: ${creds.apiKey.substring(0, 8)}…`)
    console.log('[CLOB] ⬆️  Copia a Railway: CLOB_API_KEY / CLOB_API_SECRET / CLOB_API_PASSPHRASE')

    await this.saveToSupabase(creds)
    return creds
  }
}
