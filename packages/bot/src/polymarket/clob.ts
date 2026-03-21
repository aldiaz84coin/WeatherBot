// src/polymarket/clob.ts
// Polymarket CLOB API — ejecución de órdenes reales
// ⚠️ Solo se usa cuando LIVE_TRADING=true
// Documentación: https://docs.polymarket.com/#clob

import axios from 'axios'

const CLOB_BASE = 'https://clob.polymarket.com'

export interface OrderParams {
  tokenId: string      // ID del token en Polymarket
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

export class ClobClient {
  private headers: Record<string, string>

  constructor(
    private apiKey: string,
    private privateKey: string
  ) {
    this.headers = {
      'Content-Type': 'application/json',
      'POLY_ADDRESS': this.apiKey,
    }
  }

  // Verifica el saldo disponible antes de operar
  async getBalance(): Promise<number> {
    const res = await axios.get(`${CLOB_BASE}/balance`, { headers: this.headers })
    return res.data.balance
  }

  // Coloca una orden limit de compra
  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (process.env.LIVE_TRADING !== 'true') {
      throw new Error('ClobClient: LIVE_TRADING is not enabled — aborting real order')
    }

    const body = {
      tokenID: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      orderType: 'LIMIT',
    }

    const res = await axios.post(`${CLOB_BASE}/order`, body, { headers: this.headers })
    return {
      orderId: res.data.orderID,
      status: res.data.status,
      filledSize: res.data.filledSize ?? 0,
      price: res.data.price ?? params.price,
    }
  }

  // Consulta el estado de una orden
  async getOrder(orderId: string): Promise<OrderResult> {
    const res = await axios.get(`${CLOB_BASE}/order/${orderId}`, { headers: this.headers })
    return {
      orderId: res.data.id,
      status: res.data.status,
      filledSize: res.data.filledSize ?? 0,
      price: res.data.price ?? 0,
    }
  }
}
