/**
 * Zerodha Kite Connect broker connector.
 *
 * Implements {@link BrokerConnector} against the Kite HTTP API. Nothing above
 * this file knows which broker is in use.
 *
 * The important work here is not the happy path — it is classifying failures
 * correctly, because the OMS reacts very differently to each class:
 *
 * - **Retryable** (429, 5xx): the order definitely did not reach the exchange.
 *   Safe to send again.
 * - **Uncertain** (timeout, socket hang-up): the request may or may not have
 *   been accepted. Retrying could duplicate the position, so the OMS parks the
 *   order and reconciles against the broker's own order book instead.
 * - **Fatal** (margin, bad symbol, closed market): resending changes nothing.
 *
 * Getting a timeout into the "retryable" bucket is how automated systems end
 * up with two positions where the operator intended one. That distinction is
 * the reason this file exists rather than a thin fetch wrapper.
 */

import type {
  Fill,
  Order,
  OrderRequest,
  OrderStatus,
  ProductType,
  Timestamp,
} from '../domain/types';
import { fromPaise, fromRupees, toRupees, type Paise } from '../domain/money';
import {
  BrokerError,
  BrokerUncertainError,
  type BrokerConnector,
  type BrokerOrderAck,
} from './broker';

export interface ZerodhaConfig {
  readonly apiKey: string;
  /**
   * The access token, or a function returning the current one.
   *
   * A function is what production passes (see `KiteSession`): Kite tokens
   * expire daily, and capturing a string here would pin the connector to a
   * token that goes stale every morning with no way to replace it short of a
   * restart.
   */
  readonly accessToken: string | (() => string);
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Kite allows ~10 order requests/second; stay under it. */
  readonly maxRequestsPerSecond?: number;
  readonly fetchImpl?: typeof fetch;
  /**
   * Invoked when Kite rejects the token, before the error propagates.
   *
   * Lets the session mark itself dead and alert once, rather than every caller
   * separately discovering the same expiry.
   */
  readonly onTokenRejected?: (message: string) => void;
}

interface KiteEnvelope<T> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
  error_type?: string;
}

interface KiteOrder {
  order_id: string;
  status: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number;
  price: number;
  trigger_price: number;
  product: string;
  order_type: string;
  validity: string;
  status_message: string | null;
  order_timestamp: string;
  tag?: string;
}

interface KiteTrade {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  average_price: number;
  fill_timestamp: string;
}

/**
 * Kite order states mapped onto the platform's lifecycle.
 *
 * Kite exposes several transient states ("VALIDATION PENDING", "PUT ORDER
 * REQ RECEIVED") that all mean "we have it, nothing has traded" — they map to
 * OPEN rather than to a state of their own, so the OMS state machine does not
 * need to know Kite's vocabulary.
 */
const STATUS_MAP: Readonly<Record<string, OrderStatus>> = {
  'PUT ORDER REQ RECEIVED': 'OPEN',
  'VALIDATION PENDING': 'OPEN',
  'OPEN PENDING': 'OPEN',
  'MODIFY PENDING': 'OPEN',
  'TRIGGER PENDING': 'OPEN',
  OPEN: 'OPEN',
  COMPLETE: 'FILLED',
  CANCELLED: 'CANCELLED',
  'CANCEL PENDING': 'OPEN',
  REJECTED: 'REJECTED',
};

/**
 * Kite error types that no amount of retrying will fix: `InputException`,
 * `MarginException`, `OrderException`, `PermissionException`, `TokenException`.
 *
 * They need no lookup table — anything that is not a 429 or a 5xx is treated as
 * non-retryable, so the safe classification is the default rather than
 * something a missing entry could silently opt out of. `TokenException` is the
 * one that gets extra handling below, because it invalidates the session rather
 * than just the request.
 */

export function mapKiteStatus(kiteStatus: string, filled: number, total: number): OrderStatus {
  const mapped = STATUS_MAP[kiteStatus.toUpperCase()];
  if (mapped === 'FILLED') return 'FILLED';
  if (mapped === undefined) return 'OPEN';
  // Kite reports a partially filled order as OPEN with a non-zero filled
  // quantity; the platform models that as its own state.
  if (mapped === 'OPEN' && filled > 0 && filled < total) return 'PARTIALLY_FILLED';
  return mapped;
}

/** Simple token bucket. Kite rejects bursts above its per-second order limit. */
class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.perSecond, this.tokens + elapsed * this.perSecond);
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export class ZerodhaBroker implements BrokerConnector {
  readonly name = 'zerodha';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ZerodhaConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.kite.trade';
    this.timeoutMs = config.timeoutMs ?? 7000;
    this.limiter = new RateLimiter(config.maxRequestsPerSecond ?? 8);
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;

    if (!this.fetchImpl) throw new Error('no fetch implementation available');
  }

  /** Resolved per request, so a token refreshed mid-session is picked up at once. */
  private accessToken(): string {
    const { accessToken } = this.config;
    return typeof accessToken === 'function' ? accessToken() : accessToken;
  }

  private headers(): Record<string, string> {
    return {
      'X-Kite-Version': '3',
      Authorization: `token ${this.config.apiKey}:${this.accessToken()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  /**
   * One HTTP call, with failures classified.
   *
   * `idempotencyKey` is only used to build the {@link BrokerUncertainError} —
   * it tells the OMS which intent needs reconciling.
   */
  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    await this.limiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body ? { body: new URLSearchParams(body).toString() } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // A network failure on a *mutating* call leaves the outcome genuinely
      // unknown: the request may have reached Kite before the socket died.
      const detail = error instanceof Error ? error.message : String(error);
      if (method === 'GET') {
        throw new BrokerError(`network failure calling ${path}: ${detail}`, true);
      }
      throw new BrokerUncertainError(
        `network failure on ${method} ${path}: ${detail}`,
        idempotencyKey ?? path,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: KiteEnvelope<T>;
    try {
      payload = (await response.json()) as KiteEnvelope<T>;
    } catch {
      // A mutating call that returned an unparseable body is also uncertain:
      // the order may have been accepted and the response mangled.
      if (method !== 'GET') {
        throw new BrokerUncertainError(
          `unparseable response from ${method} ${path} (HTTP ${response.status})`,
          idempotencyKey ?? path,
        );
      }
      throw new BrokerError(`unparseable response from ${path}`, true);
    }

    if (!response.ok || payload.status === 'error') {
      const message = payload.message ?? `HTTP ${response.status}`;
      const errorType = payload.error_type ?? '';

      if (response.status === 429) {
        throw new BrokerError(`rate limited: ${message}`, true, errorType);
      }
      if (response.status >= 500) {
        // 5xx on a mutating call is not safely retryable: the gateway may have
        // failed *after* the exchange accepted the order.
        if (method !== 'GET') {
          throw new BrokerUncertainError(
            `broker ${response.status} on ${method} ${path}: ${message}`,
            idempotencyKey ?? path,
          );
        }
        throw new BrokerError(`broker error ${response.status}: ${message}`, true, errorType);
      }
      // A rejected token is fatal for this call and for every subsequent one
      // until an operator logs in again, so it is surfaced once, here, rather
      // than rediscovered independently by each caller.
      if (errorType === 'TokenException') {
        this.config.onTokenRejected?.(message);
      }

      throw new BrokerError(message, false, errorType);
    }

    if (payload.data === undefined) {
      throw new BrokerError(`empty response body from ${path}`, false);
    }
    return payload.data;
  }

  /** Splits `NSE:RELIANCE` into Kite's separate exchange and tradingsymbol. */
  private static splitSymbol(symbol: string): { exchange: string; tradingsymbol: string } {
    const index = symbol.indexOf(':');
    if (index < 0) return { exchange: 'NSE', tradingsymbol: symbol };
    return { exchange: symbol.slice(0, index), tradingsymbol: symbol.slice(index + 1) };
  }

  private static mapProduct(product: ProductType): string {
    return product;
  }

  async submit(request: OrderRequest): Promise<BrokerOrderAck> {
    const { exchange, tradingsymbol } = ZerodhaBroker.splitSymbol(request.symbol);

    const body: Record<string, string> = {
      tradingsymbol,
      exchange,
      transaction_type: request.side,
      order_type: request.orderType === 'STOP' ? 'SL-M' : request.orderType === 'STOP_LIMIT' ? 'SL' : request.orderType,
      quantity: String(request.quantity),
      product: ZerodhaBroker.mapProduct(request.product),
      validity: request.timeInForce === 'IOC' ? 'IOC' : 'DAY',
      // Kite echoes the tag back on the order and in the postback, which is
      // what lets reconciliation match a broker order to our intent when the
      // submission response was lost.
      tag: request.idempotencyKey.slice(0, 20),
    };

    if (request.limitPrice !== undefined) body.price = toRupees(request.limitPrice).toFixed(2);
    if (request.triggerPrice !== undefined) {
      body.trigger_price = toRupees(request.triggerPrice).toFixed(2);
    }

    const data = await this.call<{ order_id: string }>(
      'POST', '/orders/regular', body, request.idempotencyKey,
    );

    return { brokerOrderId: data.order_id, acceptedAt: Date.now() };
  }

  async cancel(brokerOrderId: string): Promise<void> {
    await this.call<{ order_id: string }>(
      'DELETE', `/orders/regular/${encodeURIComponent(brokerOrderId)}`, undefined, brokerOrderId,
    );
  }

  async getOrder(brokerOrderId: string): Promise<Order | null> {
    const history = await this.call<KiteOrder[]>(
      'GET', `/orders/${encodeURIComponent(brokerOrderId)}`,
    );
    const latest = history[history.length - 1];
    if (!latest) return null;
    return this.toOrder(latest);
  }

  /** Finds an order by the tag we set from the idempotency key. */
  async findByTag(tag: string): Promise<Order | null> {
    const orders = await this.call<KiteOrder[]>('GET', '/orders');
    const match = orders.find((order) => order.tag === tag.slice(0, 20));
    return match ? this.toOrder(match) : null;
  }

  private toOrder(kite: KiteOrder): Order {
    const symbol = `${kite.exchange}:${kite.tradingsymbol}`;
    const status = mapKiteStatus(kite.status, kite.filled_quantity, kite.quantity);
    const timestamp = Date.parse(kite.order_timestamp) || Date.now();

    return {
      id: kite.order_id,
      request: {
        symbol,
        side: kite.transaction_type,
        quantity: kite.quantity,
        orderType: kite.order_type === 'SL' ? 'STOP_LIMIT' : kite.order_type === 'SL-M' ? 'STOP' : (kite.order_type as 'MARKET' | 'LIMIT'),
        product: kite.product as ProductType,
        timeInForce: kite.validity === 'IOC' ? 'IOC' : 'DAY',
        ...(kite.price > 0 ? { limitPrice: fromRupees(kite.price) } : {}),
        ...(kite.trigger_price > 0 ? { triggerPrice: fromRupees(kite.trigger_price) } : {}),
        strategyId: kite.tag ?? 'unknown',
        idempotencyKey: kite.tag ?? kite.order_id,
      },
      status,
      brokerOrderId: kite.order_id,
      filledQuantity: kite.filled_quantity,
      ...(kite.average_price > 0 ? { averageFillPrice: fromRupees(kite.average_price) } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(kite.status_message ? { rejectionReason: kite.status_message } : {}),
    };
  }

  async getFills(since: Timestamp): Promise<Fill[]> {
    const trades = await this.call<KiteTrade[]>('GET', '/trades');

    return trades
      .map((trade): Fill => ({
        orderId: trade.order_id,
        symbol: `${trade.exchange}:${trade.tradingsymbol}`,
        side: trade.transaction_type,
        quantity: trade.quantity,
        price: fromRupees(trade.average_price),
        timestamp: Date.parse(trade.fill_timestamp) || Date.now(),
        // Kite does not return per-trade charges on this endpoint; the
        // platform's own cost model supplies them so P&L is never silently
        // understated by treating trading as free.
        commission: 0 as Paise,
      }))
      .filter((fill) => fill.timestamp >= since)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getAvailableCash(): Promise<Paise> {
    const margins = await this.call<{ equity: { available: { live_balance: number } } }>(
      'GET', '/user/margins',
    );
    return fromRupees(margins.equity.available.live_balance);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.call<unknown>('GET', '/user/margins');
      return true;
    } catch {
      return false;
    }
  }
}

export { fromPaise };
