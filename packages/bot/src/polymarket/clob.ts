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

    // Diagnóstico on-chain del proxy (solo la primera vez)
    await this.diagnoseProxyOnce()

    const creds   = await this.getCredentials()
    const negRisk = params.negRisk ?? await this.getNegRisk(params.tokenId)

    // Log detalles del mercado para debug
    await this.logMarketInfo(params.tokenId)

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
    const nonce      = BigInt(0)    // 0 = BUY
    const sideValue  = BigInt(0)
    const sigType    = BigInt(2)    // 2 = POLY_GNOSIS_SAFE (confirmado on-chain por getSafeAddress)

    const exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE
    const taker    = negRisk ? NEG_RISK_ADAPTER  : ethers.ZeroAddress

    // Resolver maker según signatureType (replica py-clob-client/signing/builders.py::_resolve_maker_address):
    //   SignatureType.EOA (0)         → maker = signer.address (EOA)
    //   SignatureType.POLY_PROXY (1)  → maker = funder (proxy wallet)
    //   SignatureType.POLY_GNOSIS_SAFE (2) → maker = funder
    // Con sigType=1, maker DEBE ser el funder o el servidor rechaza con "invalid signature".
    const funderEnv = process.env.POLYMARKET_FUNDER?.trim()
    if (sigType !== BigInt(0) && (!funderEnv || !ethers.isAddress(funderEnv))) {
      throw new Error('[CLOB] POLYMARKET_FUNDER env var no definido o inválido — requerido para signatureType 1/2 (proxy wallets)')
    }
    const makerAddress = sigType === BigInt(0) ? this.wallet.address : funderEnv!
    console.log(`[CLOB] maker=${makerAddress} | signer=${this.wallet.address} | sigType=${sigType}`)

    const orderStruct = {
      salt:          salt,
      maker:         makerAddress,
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

      // ── Verificación local de la firma ──
      // Si recovered !== signer, nuestro proceso de firma está roto (domain/types/struct).
      // Si recovered === signer pero el servidor rechaza → problema de ownership on-chain.
      const recovered = ethers.verifyTypedData(domain, ORDER_TYPES, orderStruct, signature)
      const matches = recovered.toLowerCase() === this.wallet.address.toLowerCase()
      console.log(`[CLOB] verifyTypedData local: recovered=${recovered} | signer=${this.wallet.address} | ${matches ? '✅ OK' : '❌ MISMATCH'}`)
      if (!matches) {
        throw new Error(`[CLOB] Firma local inválida: recovered ${recovered} !== signer ${this.wallet.address}`)
      }
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
      maker:         makerAddress,
      signer:        this.wallet.address,
      taker:         taker,
      tokenId:       params.tokenId,
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    expiration.toString(),
      nonce:         nonce.toString(),
      feeRateBps:    feeRateBps.toString(),
      side:          'BUY',                    // string, igual que Python SignedOrder.side
      signatureType: Number(sigType),
      signature,
    }

    // owner = UUID de la API key L2 (NO una address).
    // Replica exactamente py-clob-client: body = order_to_json(order, self.creds.api_key, orderType)
    // El servidor verifica que owner === apiKey de tus credenciales L2.
    const bodyObj = {
      order:     orderPayload,
      owner:     creds.apiKey,
      orderType: 'GTC',
      negRisk,
    }
    const body      = JSON.stringify(bodyObj)
    const path      = '/order'
    const timestamp = Math.floor(Date.now() / 1000)

    const l2Headers = buildL2Headers(creds, 'POST', path, body, timestamp)

    // ── 6. Enviar al CLOB REST API ────────────────────────────────────────
    // Log completo del payload para debug — muestra todo excepto la private key
    console.log('[CLOB] ── PAYLOAD COMPLETO ──────────────────────────────')
    console.log('[CLOB] URL:    POST https://clob.polymarket.com/order')
    console.log('[CLOB] domain: ' + JSON.stringify({ name: domain.name, verifyingContract: exchange }))
    console.log('[CLOB] body:   ' + body)
    console.log('[CLOB] ────────────────────────────────────────────────────')
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

  private ownerAddressCache: string | null = null
  private diagnosedProxy: boolean = false

  // Diagnóstico on-chain: consulta al CTFExchange qué direcciones de proxy
  // corresponden a esta EOA y las compara con POLYMARKET_FUNDER.
  // Se ejecuta una sola vez por instancia del proceso.
  async diagnoseProxyOnce(): Promise<void> {
    if (this.diagnosedProxy) return
    this.diagnosedProxy = true

    // Lista de RPCs públicos de Polygon con fallback automático.
    // Define POLYGON_RPC_URL en env para usar uno propio (Alchemy/Infura).
    const rpcUrls = [
      process.env.POLYGON_RPC_URL,
      'https://polygon.llamarpc.com',
      'https://polygon.drpc.org',
      'https://rpc.ankr.com/polygon',
      'https://1rpc.io/matic',
      'https://polygon-bor-rpc.publicnode.com',
    ].filter(Boolean) as string[]

    const eoa = this.wallet.address
    const funderEnv = process.env.POLYMARKET_FUNDER?.trim()

    console.log('[CLOB-DIAG] ══════ Diagnóstico on-chain del proxy ══════')
    console.log(`[CLOB-DIAG] EOA (signer):   ${eoa}`)
    console.log(`[CLOB-DIAG] POLYMARKET_FUNDER (env): ${funderEnv ?? '(no definido)'}`)

    const registryAbi = [
      'function getSafeAddress(address signer) external view returns (address)',
      'function getPolyProxyWalletAddress(address signer) external view returns (address)',
    ]

    // Intenta conectarse a cada RPC hasta encontrar uno que funcione
    let provider: ethers.JsonRpcProvider | null = null
    let workingRpc = ''
    for (const url of rpcUrls) {
      try {
        const p = new ethers.JsonRpcProvider(url, 137, { staticNetwork: true })
        // Test rápido: getBlockNumber
        await Promise.race([
          p.getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        provider = p
        workingRpc = url
        console.log(`[CLOB-DIAG] RPC OK: ${url}`)
        break
      } catch (err: any) {
        console.log(`[CLOB-DIAG] RPC falló (${url}): ${err?.shortMessage ?? err?.message}`)
      }
    }

    if (!provider) {
      console.log('[CLOB-DIAG] ❌ Ningún RPC responde — no se puede diagnosticar.')
      console.log('[CLOB-DIAG]    Añade POLYGON_RPC_URL=<tu RPC> a Railway (Alchemy/Infura)')
      console.log('[CLOB-DIAG] ════════════════════════════════════════════')
      return
    }

    try {
      const exchange = new ethers.Contract(CTF_EXCHANGE, registryAbi, provider)

      let expectedSafe:  string | null = null
      let expectedProxy: string | null = null

      try {
        expectedSafe = await exchange.getSafeAddress(eoa)
        console.log(`[CLOB-DIAG] getSafeAddress(EOA)            → ${expectedSafe}   [sigType=2 / Safe]`)
      } catch (err: any) {
        console.log(`[CLOB-DIAG] getSafeAddress(EOA)            → ERROR: ${err?.shortMessage ?? err?.message}`)
      }

      try {
        expectedProxy = await exchange.getPolyProxyWalletAddress(eoa)
        console.log(`[CLOB-DIAG] getPolyProxyWalletAddress(EOA) → ${expectedProxy}  [sigType=1 / Magic]`)
      } catch (err: any) {
        console.log(`[CLOB-DIAG] getPolyProxyWalletAddress(EOA) → ERROR: ${err?.shortMessage ?? err?.message}`)
      }

      if (funderEnv) {
        const fLower = funderEnv.toLowerCase()
        const matchSafe  = expectedSafe?.toLowerCase()  === fLower
        const matchProxy = expectedProxy?.toLowerCase() === fLower

        if (matchSafe) {
          console.log('[CLOB-DIAG] ✅ POLYMARKET_FUNDER coincide con Safe → USA sigType=2')
        } else if (matchProxy) {
          console.log('[CLOB-DIAG] ✅ POLYMARKET_FUNDER coincide con Magic proxy → USA sigType=1')
        } else {
          console.log('[CLOB-DIAG] ❌ POLYMARKET_FUNDER NO coincide con ningún proxy derivado de la EOA')
          console.log('[CLOB-DIAG]    Opciones para arreglar:')
          if (expectedSafe)  console.log(`[CLOB-DIAG]    → Safe:  POLYMARKET_FUNDER=${expectedSafe} + sigType=2`)
          if (expectedProxy) console.log(`[CLOB-DIAG]    → Magic: POLYMARKET_FUNDER=${expectedProxy} + sigType=1`)
        }
      }

      // Balance USDC.e del funder actual
      if (funderEnv) {
        try {
          const usdcAbi = ['function balanceOf(address) view returns (uint256)']
          const usdc = new ethers.Contract(COLLATERAL_TOKEN, usdcAbi, provider)
          const balance: bigint = await usdc.balanceOf(funderEnv)
          console.log(`[CLOB-DIAG] Balance USDC.e del funder: ${ethers.formatUnits(balance, 6)} USDC`)
        } catch (err: any) {
          console.log(`[CLOB-DIAG] No se pudo leer balance USDC: ${err?.shortMessage ?? err?.message}`)
        }
      }
    } catch (err: any) {
      console.log(`[CLOB-DIAG] ERROR consultando contrato: ${err?.shortMessage ?? err?.message}`)
    }

    console.log('[CLOB-DIAG] ════════════════════════════════════════════')
  }

  // Fetch info de un mercado específico desde el CLOB REST para ver neg_risk
  async logMarketInfo(tokenId: string): Promise<void> {
    try {
      const res = await fetch(
        `${CLOB_HOST}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`,
        { signal: AbortSignal.timeout(8_000) }
      )
      const data: any = await res.json()
      const markets: any[] = Array.isArray(data) ? data : (data?.data ?? [])
      const m = markets[0]
      if (!m) {
        console.log(`[CLOB-MARKET] No se encontró mercado para token ${tokenId.substring(0, 16)}…`)
        return
      }
      console.log(`[CLOB-MARKET] token=${tokenId.substring(0, 16)}…`)
      console.log(`[CLOB-MARKET]   question:        ${m.question ?? '?'}`)
      console.log(`[CLOB-MARKET]   neg_risk:        ${m.neg_risk}`)
      console.log(`[CLOB-MARKET]   tick_size:       ${m.tick_size ?? m.minimum_tick_size ?? '?'}`)
      console.log(`[CLOB-MARKET]   minimum_order_size: ${m.minimum_order_size ?? '?'}`)
      console.log(`[CLOB-MARKET]   accepting_orders: ${m.accepting_orders}`)
      console.log(`[CLOB-MARKET]   active:          ${m.active}`)
      console.log(`[CLOB-MARKET]   closed:          ${m.closed}`)
      console.log(`[CLOB-MARKET]   condition_id:    ${m.condition_id ?? '?'}`)
    } catch (err: any) {
      console.log(`[CLOB-MARKET] Error: ${err?.message}`)
    }
  }

  async resolveOwnerAddress(creds: L2Credentials): Promise<string> {
    if (process.env.POLYMARKET_FUNDER) {
      const addr = process.env.POLYMARKET_FUNDER.trim()
      if (addr.toLowerCase() !== this.wallet.address.toLowerCase()) {
        console.log(`[CLOB] owner → POLYMARKET_FUNDER: ${addr}`)
        return addr
      }
    }
    if (this.ownerAddressCache) return this.ownerAddressCache
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const msg = `${timestamp}GET/auth/api-key`
      const sig = await this.wallet.signMessage(msg)
      const res = await fetch(`${CLOB_HOST}/auth/api-key`, {
        method: 'POST', headers: {
          'Content-Type': 'application/json', 'POLY-ADDRESS': this.wallet.address,
          'POLY-SIGNATURE': sig, 'POLY-TIMESTAMP': String(timestamp), 'POLY-NONCE': '0',
        }, body: '{}', signal: AbortSignal.timeout(10_000),
      })
      const data: any = await res.json()
      console.log('[CLOB] L1 discovery raw:', JSON.stringify(data))
      const discovered = data?.funder ?? data?.proxyWallet ?? null
      if (discovered && ethers.isAddress(discovered)
          && discovered.toLowerCase() !== this.wallet.address.toLowerCase()) {
        console.log(`[CLOB] ✅ Proxy wallet: ${discovered}`)
        this.ownerAddressCache = discovered
        return discovered
      }
    } catch (err: any) { console.warn('[CLOB] L1 discovery fallida:', err?.message) }
    console.warn('[CLOB] ⚠️  Usando EOA como owner.')
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
      // Respuesta: { "base_fee": 1000 } (API reference oficial)
      // Aunque algunos docs mencionan "fee_rate_bps", el campo real es "base_fee".
      const rate = parseInt(
        data?.base_fee ?? data?.fee_rate_bps ?? data?.feeRateBps ?? '0',
        10
      )
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
    // Polymarket L1 auth: py-clob-client usa personal_sign (eth_sign / EIP-191)
    // con el mensaje "{timestamp}GET/auth/api-key" — NO EIP-712 TypedData.
    // Referencia: web3.eth.account.sign_message(encode_defunct(text=msg), private_key)
    // En ethers v6: wallet.signMessage(msg) produce el mismo resultado.
    const timestamp = Math.floor(Date.now() / 1000)
    const msg = `${timestamp}GET/auth/api-key`

    // personal_sign (EIP-191): igual que web3 encode_defunct + sign_message
    const sig = await this.wallet.signMessage(msg)

    console.log(`[CLOB] Derivando credenciales L1 (personal_sign): ${msg}`)

    // Intento 1: GET (método original de py-clob-client self.get("/auth/api-key"))
    let res = await fetch(`${CLOB_HOST}/auth/api-key`, {
      method:  'GET',
      headers: {
        'POLY-ADDRESS':   this.wallet.address,
        'POLY-SIGNATURE': sig,
        'POLY-TIMESTAMP': String(timestamp),
        'POLY-NONCE':     '0',
      },
      signal: AbortSignal.timeout(10_000),
    })

    // Intento 2: si GET devuelve 405, probar POST con body '{}'
    if (res.status === 405) {
      console.log('[CLOB] GET → 405, reintentando con POST…')
      res = await fetch(`${CLOB_HOST}/auth/api-key`, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'POLY-ADDRESS':   this.wallet.address,
          'POLY-SIGNATURE': sig,
          'POLY-TIMESTAMP': String(timestamp),
          'POLY-NONCE':     '0',
        },
        body:   '{}',
        signal: AbortSignal.timeout(10_000),
      })
    }

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`[CLOB] Error derivando credenciales (HTTP ${res.status}): ${text}`)
    }

    const data: any = await res.json()
    console.log('[CLOB] /auth/api-key raw:', JSON.stringify(data))

    if (data?.funder && ethers.isAddress(data.funder)) {
      console.log(`[CLOB] 💡 Proxy wallet: ${data.funder} → añade POLYMARKET_FUNDER=${data.funder} en Railway`)
    }

    const creds: L2Credentials = {
      apiKey:        data.apiKey        ?? data.key,
      apiSecret:     data.secret,
      apiPassphrase: data.passphrase,
      walletAddress: this.wallet.address,
      derivedAt:     new Date().toISOString(),
    }

    console.log(`[CLOB] ✅ Credenciales derivadas — apiKey: ${creds.apiKey?.substring(0, 8)}…`)
    console.log('[CLOB]    Guarda en Railway: CLOB_API_KEY / CLOB_API_SECRET / CLOB_API_PASSPHRASE')
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
