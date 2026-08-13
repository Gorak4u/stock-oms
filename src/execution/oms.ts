/**
 * Order Management System.
 *
 * Owns the lifecycle of every order and, above all, guarantees that one
 * trading intent produces exactly one order at the exchange.
 *
 * Duplicate orders are the most expensive bug in automated trading: a retry
 * after a timeout, a restart that replays a queue, or two workers consuming
 * the same signal all silently double a position. Three mechanisms prevent it:
 *
 * 1. **Deterministic idempotency keys.** The key is derived from the intent
 *    (strategy, symbol, side, quantity, decision bar), not from a random UUID.
 *    The same intent re-derived after a crash produces the same key.
 * 2. **A key registry checked before submission.** A key already in flight or
 *    already terminal is refused locally, without a broker round trip.
 * 3. **Reconciliation on uncertainty.** When a submission's outcome is unknown,
 *    the OMS asks the broker what it actually has before deciding — it never
 *    blindly retries.
 */

import { createHash } from 'node:crypto';
import type {
  Fill,
  Order,
  OrderRequest,
  OrderStatus,
  Side,
  Timestamp,
} from '../domain/types';
import { isTerminal } from '../domain/types';
import type { Paise } from '../domain/money';
import { BrokerError, BrokerUncertainError, type BrokerConnector } from './broker';
import type { AuditSink } from '../audit/log';

/** Legal state transitions. Anything absent here is a bug, not an edge case. */
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_NEW: ['OPEN', 'REJECTED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class OrderStateError extends Error {
  constructor(from: OrderStatus, to: OrderStatus, orderId: string) {
    super(`illegal transition ${from} → ${to} for order ${orderId}`);
    this.name = 'OrderStateError';
  }
}

export class DuplicateOrderError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly existingOrderId: string,
  ) {
    super(`order with idempotency key ${idempotencyKey} already exists as ${existingOrderId}`);
    this.name = 'DuplicateOrderError';
  }
}

/**
 * The intent an order expresses, before it becomes an order.
 *
 * `decisionBar` is the timestamp of the bar the decision was made on. Including
 * it means the same strategy reacting to the same bar always produces the same
 * key, while a genuine new decision on the next bar produces a different one.
 */
export interface TradeIntent {
  readonly strategyId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly decisionBar: Timestamp;
}

/** SHA-256 of the intent fields, truncated — collision-free in practice, readable in logs. */
export function idempotencyKeyFor(intent: TradeIntent): string {
  const canonical = [
    intent.strategyId,
    intent.symbol,
    intent.side,
    String(intent.quantity),
    String(intent.decisionBar),
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export interface SubmitResult {
  readonly order: Order;
  readonly submitted: boolean;
  /** Set when the order was refused locally rather than sent. */
  readonly refusedReason?: string;
}

export interface OrderManagerConfig {
  readonly broker: BrokerConnector;
  readonly audit?: AuditSink;
  /** Retries for retryable broker errors. Uncertain outcomes are never retried blindly. */
  readonly maxRetries?: number;
  readonly clock?: () => Timestamp;
}

export class OrderManager {
  private readonly broker: BrokerConnector;
  private readonly audit: AuditSink | undefined;
  private readonly maxRetries: number;
  private readonly clock: () => Timestamp;

  private readonly orders = new Map<string, Order>();
  /** idempotency key → order id. The duplicate-prevention registry. */
  private readonly keyRegistry = new Map<string, string>();
  private readonly fillsByOrder = new Map<string, Fill[]>();
  private submissionTimestamps: Timestamp[] = [];

  constructor(config: OrderManagerConfig) {
    this.broker = config.broker;
    this.audit = config.audit;
    this.maxRetries = config.maxRetries ?? 2;
    this.clock = config.clock ?? (() => Date.now());
  }

  /**
   * Builds a request from an intent, deriving the idempotency key.
   *
   * Callers should always go through this rather than hand-rolling a request —
   * a hand-supplied key is how duplicate prevention gets bypassed.
   */
  buildRequest(
    intent: TradeIntent,
    options: Omit<OrderRequest, keyof TradeIntent | 'idempotencyKey' | 'quantity'> &
      Partial<Pick<OrderRequest, 'quantity'>>,
  ): OrderRequest {
    return {
      symbol: intent.symbol,
      side: intent.side,
      quantity: options.quantity ?? intent.quantity,
      orderType: options.orderType,
      product: options.product,
      timeInForce: options.timeInForce,
      ...(options.limitPrice !== undefined ? { limitPrice: options.limitPrice } : {}),
      ...(options.triggerPrice !== undefined ? { triggerPrice: options.triggerPrice } : {}),
      strategyId: intent.strategyId,
      idempotencyKey: idempotencyKeyFor(intent),
    };
  }

  /**
   * Submits an order.
   *
   * The `PENDING_NEW` record and the key registration both happen *before* the
   * broker call. If the process dies mid-flight, restart finds a `PENDING_NEW`
   * order whose fate is unknown and reconciles it, instead of having no record
   * that anything was ever sent.
   */
  async submit(request: OrderRequest, correlationId: string): Promise<SubmitResult> {
    const now = this.clock();

    const existingOrderId = this.keyRegistry.get(request.idempotencyKey);
    if (existingOrderId !== undefined) {
      const existing = this.orders.get(existingOrderId)!;
      this.audit?.append(
        'ORDER_REJECTED',
        correlationId,
        {
          reason: 'DUPLICATE_IDEMPOTENCY_KEY',
          idempotencyKey: request.idempotencyKey,
          existingOrderId,
        },
        now,
      );
      return {
        order: existing,
        submitted: false,
        refusedReason: `duplicate of ${existingOrderId}`,
      };
    }

    const orderId = `ord-${request.idempotencyKey.slice(0, 12)}`;
    const staged: Order = {
      id: orderId,
      request,
      status: 'PENDING_NEW',
      filledQuantity: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(orderId, staged);
    this.keyRegistry.set(request.idempotencyKey, orderId);
    this.audit?.append('ORDER_STAGED', correlationId, { orderId, request }, now);

    let attempt = 0;

    while (true) {
      try {
        this.audit?.append(
          'ORDER_SUBMITTED',
          correlationId,
          { orderId, attempt },
          this.clock(),
        );
        const ack = await this.broker.submit(request);
        this.submissionTimestamps.push(this.clock());

        const acknowledged = this.transition(orderId, 'OPEN', {
          brokerOrderId: ack.brokerOrderId,
        });
        this.audit?.append(
          'ORDER_ACKNOWLEDGED',
          correlationId,
          { orderId, brokerOrderId: ack.brokerOrderId },
          this.clock(),
        );
        return { order: acknowledged, submitted: true };
      } catch (error) {
        if (error instanceof BrokerUncertainError) {
          // Outcome unknown. Retrying could duplicate, so leave the order in
          // PENDING_NEW for reconciliation to resolve against the broker.
          this.audit?.append(
            'RECONCILIATION_BREAK',
            correlationId,
            { orderId, reason: error.message, idempotencyKey: error.idempotencyKey },
            this.clock(),
          );
          return {
            order: this.orders.get(orderId)!,
            submitted: false,
            refusedReason: `uncertain outcome, awaiting reconciliation: ${error.message}`,
          };
        }

        const retryable = error instanceof BrokerError && error.retryable;
        if (retryable && attempt < this.maxRetries) {
          attempt += 1;
          continue;
        }

        const reason = error instanceof Error ? error.message : String(error);
        const rejected = this.transition(orderId, 'REJECTED', { rejectionReason: reason });
        this.audit?.append('ORDER_REJECTED', correlationId, { orderId, reason }, this.clock());
        return { order: rejected, submitted: false, refusedReason: reason };
      }
    }
  }

  /** Applies a fill, advancing quantity, average price and status. */
  applyFill(fill: Fill, correlationId: string): Order {
    const order = this.orders.get(fill.orderId) ?? this.findByBrokerOrderId(fill.orderId);
    if (!order) throw new Error(`fill for unknown order ${fill.orderId}`);

    const fills = this.fillsByOrder.get(order.id) ?? [];
    // Exchanges and reconciliation both replay fills; folding one twice would
    // corrupt both the position and the average price.
    const alreadySeen = fills.some(
      (seen) =>
        seen.timestamp === fill.timestamp &&
        seen.quantity === fill.quantity &&
        seen.price === fill.price,
    );
    if (alreadySeen) return order;

    fills.push(fill);
    this.fillsByOrder.set(order.id, fills);

    const filledQuantity = order.filledQuantity + fill.quantity;
    const previousNotional = (order.averageFillPrice ?? 0) * order.filledQuantity;
    const averageFillPrice = Math.round(
      (previousNotional + fill.quantity * fill.price) / filledQuantity,
    ) as Paise;

    const status: OrderStatus =
      filledQuantity >= order.request.quantity ? 'FILLED' : 'PARTIALLY_FILLED';

    const updated = this.transition(order.id, status, { filledQuantity, averageFillPrice });
    this.audit?.append('FILL_RECEIVED', correlationId, { orderId: order.id, fill }, fill.timestamp);
    return updated;
  }

  async cancel(orderId: string, correlationId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    if (isTerminal(order.status)) return order;

    if (order.brokerOrderId) await this.broker.cancel(order.brokerOrderId);

    const cancelled = this.transition(orderId, 'CANCELLED', {});
    this.audit?.append('ORDER_CANCELLED', correlationId, { orderId }, this.clock());
    return cancelled;
  }

  /**
   * Resolves orders whose state the platform is unsure of.
   *
   * Called on startup and periodically. The broker is the authority: whatever
   * it reports wins, because it is the side that actually holds the position.
   */
  async reconcile(correlationId = 'reconciliation'): Promise<{
    resolved: number;
    breaks: { orderId: string; detail: string }[];
  }> {
    const breaks: { orderId: string; detail: string }[] = [];
    let resolved = 0;

    for (const order of this.orders.values()) {
      if (isTerminal(order.status)) continue;

      if (!order.brokerOrderId) {
        // Staged but never acknowledged. Without a broker id there is nothing
        // to query, so a human has to confirm against the broker's order book.
        if (order.status === 'PENDING_NEW') {
          breaks.push({
            orderId: order.id,
            detail: 'PENDING_NEW with no broker id — verify manually before resubmitting',
          });
          this.audit?.append(
            'RECONCILIATION_BREAK',
            correlationId,
            { orderId: order.id, reason: 'no broker id' },
            this.clock(),
          );
        }
        continue;
      }

      const remote = await this.broker.getOrder(order.brokerOrderId);
      if (!remote) {
        breaks.push({ orderId: order.id, detail: 'broker has no record of this order' });
        this.audit?.append(
          'RECONCILIATION_BREAK',
          correlationId,
          { orderId: order.id, reason: 'missing at broker' },
          this.clock(),
        );
        continue;
      }

      if (remote.status !== order.status || remote.filledQuantity !== order.filledQuantity) {
        this.orders.set(order.id, {
          ...order,
          status: remote.status,
          filledQuantity: remote.filledQuantity,
          ...(remote.averageFillPrice !== undefined
            ? { averageFillPrice: remote.averageFillPrice }
            : {}),
          updatedAt: this.clock(),
        });
        resolved += 1;
      }
    }

    return { resolved, breaks };
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  getOrderByKey(idempotencyKey: string): Order | undefined {
    const orderId = this.keyRegistry.get(idempotencyKey);
    return orderId ? this.orders.get(orderId) : undefined;
  }

  getOpenOrders(): Order[] {
    return [...this.orders.values()].filter((order) => !isTerminal(order.status));
  }

  /** Submission times within the last minute — feeds the risk engine's rate breaker. */
  recentSubmissions(now: Timestamp = this.clock()): Timestamp[] {
    this.submissionTimestamps = this.submissionTimestamps.filter(
      (timestamp) => now - timestamp < 60_000,
    );
    return [...this.submissionTimestamps];
  }

  private findByBrokerOrderId(brokerOrderId: string): Order | undefined {
    for (const order of this.orders.values()) {
      if (order.brokerOrderId === brokerOrderId) return order;
    }
    return undefined;
  }

  private transition(
    orderId: string,
    to: OrderStatus,
    patch: Partial<Omit<Order, 'id' | 'request' | 'status'>>,
  ): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);

    if (order.status !== to && !canTransition(order.status, to)) {
      throw new OrderStateError(order.status, to, orderId);
    }

    const updated: Order = { ...order, ...patch, status: to, updatedAt: this.clock() };
    this.orders.set(orderId, updated);
    return updated;
  }
}
