/** Core vocabulary shared by every layer. Pure data — no behaviour, no I/O. */

import type { Paise } from './money';

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export type Exchange = 'NSE' | 'BSE';

export type InstrumentKind = 'EQUITY' | 'FUTURE' | 'OPTION' | 'INDEX';

export type OptionRight = 'CE' | 'PE';

export interface Instrument {
  /** Stable platform-wide key, e.g. `NSE:RELIANCE` or `NSE:NIFTY24DEC22000CE`. */
  readonly symbol: string;
  readonly exchange: Exchange;
  readonly kind: InstrumentKind;
  /** Shares per lot. 1 for cash equity. */
  readonly lotSize: number;
  readonly tickSize: Paise;
  /** Derivatives only. */
  readonly expiry?: string;
  readonly strike?: Paise;
  readonly right?: OptionRight;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** Milliseconds since the Unix epoch. Every timestamp in the platform is UTC. */
export type Timestamp = number;

export interface Tick {
  readonly symbol: string;
  readonly timestamp: Timestamp;
  readonly price: Paise;
  /** Quantity traded at this print. */
  readonly quantity: number;
  readonly bid?: Paise;
  readonly ask?: Paise;
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '1d';

export interface Candle {
  readonly symbol: string;
  readonly interval: Interval;
  /** Start of the bar's time window. */
  readonly timestamp: Timestamp;
  readonly open: Paise;
  readonly high: Paise;
  readonly low: Paise;
  readonly close: Paise;
  readonly volume: number;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type Side = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

export type TimeInForce = 'DAY' | 'IOC';

export type ProductType = 'CNC' | 'MIS' | 'NRML';

/**
 * Order lifecycle.
 *
 * `PENDING_NEW` is the state between "we decided to send it" and "the broker
 * acknowledged it" — the window in which a crash would otherwise leave an
 * order whose existence at the exchange is unknown. It is persisted before the
 * broker call, which is what makes recovery-on-restart possible.
 */
export type OrderStatus =
  | 'PENDING_NEW'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED';

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED'];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export interface OrderRequest {
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly orderType: OrderType;
  readonly product: ProductType;
  readonly timeInForce: TimeInForce;
  /** Required for LIMIT and STOP_LIMIT. */
  readonly limitPrice?: Paise;
  /** Required for STOP and STOP_LIMIT. */
  readonly triggerPrice?: Paise;
  /** Strategy that originated the order, for attribution and audit. */
  readonly strategyId: string;
  /**
   * Caller-supplied key that makes submission idempotent. Two requests with
   * the same key are the same order, however many times they are retried.
   */
  readonly idempotencyKey: string;
}

export interface Order {
  readonly id: string;
  readonly request: OrderRequest;
  readonly status: OrderStatus;
  /** Broker's own identifier; absent until the broker acknowledges. */
  readonly brokerOrderId?: string;
  readonly filledQuantity: number;
  /** Quantity-weighted average fill price; `undefined` until the first fill. */
  readonly averageFillPrice?: Paise;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly rejectionReason?: string;
}

export interface Fill {
  /**
   * The order this fill belongs to.
   *
   * A broker reports fills against its *own* order id, which is not the
   * platform's. Fills are resolved at the boundary — see
   * `TradingService.applyFill` — so by the time one is stored this holds the
   * platform order id whenever that order is known, and the broker's id when it
   * is not. Either way it is stable, which is what makes replaying a fill a
   * no-op rather than a double count.
   */
  readonly orderId: string;
  /** The broker's own reference, kept so a fill can be traced back to the venue. */
  readonly brokerOrderId?: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly price: Paise;
  readonly timestamp: Timestamp;
  readonly commission: Paise;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface Position {
  readonly symbol: string;
  /** Signed: positive is long, negative is short, zero means flat. */
  readonly quantity: number;
  /** Average price of the open quantity. Zero when flat. */
  readonly averagePrice: Paise;
  readonly realisedPnl: Paise;
  readonly unrealisedPnl: Paise;
  /** Latest price used to mark the position. */
  readonly lastPrice: Paise;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalDirection = 'LONG' | 'SHORT' | 'FLAT';

export interface Signal {
  readonly symbol: string;
  readonly strategyId: string;
  readonly direction: SignalDirection;
  /** Strategy conviction in [0, 1]. Drives position size, never direction. */
  readonly strength: number;
  readonly timestamp: Timestamp;
  /** Price the signal was computed against. */
  readonly referencePrice: Paise;
  /** Protective stop suggested by the strategy. */
  readonly stopLoss?: Paise;
  readonly takeProfit?: Paise;
  /** Human-readable justification, carried into the audit log. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

/**
 * How far an intent travels without a human.
 *
 * - `MANUAL`   — signals are recorded, nothing is sent.
 * - `APPROVAL` — orders are staged and wait for an explicit approval.
 * - `AUTOMATIC`— orders are sent as soon as they clear risk.
 */
export type AutomationMode = 'MANUAL' | 'APPROVAL' | 'AUTOMATIC';
