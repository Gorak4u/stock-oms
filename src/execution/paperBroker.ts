/**
 * Simulated broker.
 *
 * Backs both backtesting and paper trading, so the same fill logic is
 * exercised in research and in the pre-live rehearsal. Sharing it is the point:
 * a strategy that behaves differently in the two has a bug in one of them, and
 * the usual culprit is two separate fill simulators drifting apart.
 *
 * The model is intentionally pessimistic:
 *
 * - Market orders slip against you by a configurable fraction.
 * - Limit orders fill only when price trades *through* the limit, never merely
 *   touching it — resting at the touch does not guarantee a fill in reality.
 * - Fills are capped by a share of the bar's volume, so a backtest cannot
 *   pretend to buy more than the market traded.
 *
 * An optimistic simulator produces a beautiful equity curve and a losing
 * account.
 */

import type { Fill, Order, OrderRequest, Timestamp } from '../domain/types';
import { fromPaise, mulRate, roundToTick, type Paise } from '../domain/money';
import { computeCosts, DEFAULT_COST_SCHEDULE, type CostSchedule } from './costs';
import { BrokerError, type BrokerConnector, type BrokerOrderAck } from './broker';

export interface PaperBrokerConfig {
  /** Adverse price move applied to market orders, as a fraction. 0.0005 = 5bps. */
  readonly slippageFraction?: number;
  readonly costSchedule?: CostSchedule;
  /** Largest share of a bar's volume a single order may consume. */
  readonly maxVolumeParticipation?: number;
  /** Seed cash reported by `getAvailableCash`. */
  readonly openingCash?: Paise;
}

interface RestingOrder {
  order: Order;
  request: OrderRequest;
}

export type FillListener = (fill: Fill) => void;

export class PaperBroker implements BrokerConnector {
  readonly name = 'paper';

  private readonly slippageFraction: number;
  private readonly costSchedule: CostSchedule;
  private readonly maxVolumeParticipation: number;

  private readonly resting = new Map<string, RestingOrder>();
  private readonly completed = new Map<string, Order>();
  /** Guards against duplicate submission of the same idempotency key. */
  private readonly seenKeys = new Map<string, string>();
  private readonly fills: Fill[] = [];
  private readonly listeners: FillListener[] = [];

  private prices = new Map<string, Paise>();
  private clock: Timestamp = 0;
  private sequence = 0;
  private cash: Paise;

  constructor(config: PaperBrokerConfig = {}) {
    this.slippageFraction = config.slippageFraction ?? 0.0005;
    this.costSchedule = config.costSchedule ?? DEFAULT_COST_SCHEDULE;
    this.maxVolumeParticipation = config.maxVolumeParticipation ?? 0.1;
    this.cash = config.openingCash ?? (0 as Paise);
  }

  onFill(listener: FillListener): void {
    this.listeners.push(listener);
  }

  /** Advances the simulated clock. Fills are stamped with it. */
  setClock(timestamp: Timestamp): void {
    this.clock = timestamp;
  }

  /**
   * Publishes a new price and works any resting orders it triggers.
   *
   * `barVolume` bounds how much can fill; omit it to leave the order
   * unconstrained (appropriate for liquid large-caps at small sizes).
   */
  setPrice(symbol: string, price: Paise, barVolume?: number): Fill[] {
    this.prices.set(symbol, price);
    return this.workRestingOrders(symbol, price, barVolume);
  }

  async submit(request: OrderRequest): Promise<BrokerOrderAck> {
    const duplicate = this.seenKeys.get(request.idempotencyKey);
    if (duplicate !== undefined) {
      throw new BrokerError(
        `duplicate idempotency key ${request.idempotencyKey} (original order ${duplicate})`,
        false,
        'DUPLICATE_ORDER',
      );
    }

    if (request.quantity <= 0) {
      throw new BrokerError(`invalid quantity ${request.quantity}`, false, 'INVALID_QUANTITY');
    }
    if (
      (request.orderType === 'LIMIT' || request.orderType === 'STOP_LIMIT') &&
      request.limitPrice === undefined
    ) {
      throw new BrokerError(`${request.orderType} requires a limit price`, false, 'MISSING_PRICE');
    }
    if (
      (request.orderType === 'STOP' || request.orderType === 'STOP_LIMIT') &&
      request.triggerPrice === undefined
    ) {
      throw new BrokerError(`${request.orderType} requires a trigger price`, false, 'MISSING_PRICE');
    }

    this.sequence += 1;
    const brokerOrderId = `paper-${this.sequence}`;
    this.seenKeys.set(request.idempotencyKey, brokerOrderId);

    const order: Order = {
      id: brokerOrderId,
      request,
      status: 'OPEN',
      brokerOrderId,
      filledQuantity: 0,
      createdAt: this.clock,
      updatedAt: this.clock,
    };

    this.resting.set(brokerOrderId, { order, request });

    // The order is acknowledged here but not filled. Firing a fill inside
    // `submit` would deliver it before the caller has recorded the broker order
    // id from this ack, and the fill would arrive for an order the OMS cannot
    // yet identify. Real venues have the same ordering hazard — a fill can
    // reach the socket before the REST ack returns — so the simulator must not
    // paper over it. Callers work the order with the next `setPrice`.
    return { brokerOrderId, acceptedAt: this.clock };
  }

  async cancel(brokerOrderId: string): Promise<void> {
    const resting = this.resting.get(brokerOrderId);
    if (!resting) {
      throw new BrokerError(`unknown or already-terminal order ${brokerOrderId}`, false);
    }
    this.resting.delete(brokerOrderId);
    this.completed.set(brokerOrderId, {
      ...resting.order,
      status: 'CANCELLED',
      updatedAt: this.clock,
    });
  }

  async getOrder(brokerOrderId: string): Promise<Order | null> {
    return this.resting.get(brokerOrderId)?.order ?? this.completed.get(brokerOrderId) ?? null;
  }

  async getFills(since: number): Promise<Fill[]> {
    return this.fills.filter((fill) => fill.timestamp >= since);
  }

  async getAvailableCash(): Promise<Paise> {
    return this.cash;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  /** Matches resting orders for a symbol against a new price. */
  private workRestingOrders(symbol: string, price: Paise, barVolume?: number): Fill[] {
    const produced: Fill[] = [];

    for (const [brokerOrderId, resting] of [...this.resting.entries()]) {
      const { request } = resting;
      if (request.symbol !== symbol) continue;

      const fillPrice = this.resolveFillPrice(request, price);
      if (fillPrice === null) continue;

      const remaining = request.quantity - resting.order.filledQuantity;
      const capacity =
        barVolume === undefined
          ? remaining
          : Math.max(0, Math.floor(barVolume * this.maxVolumeParticipation));
      const quantity = Math.min(remaining, capacity);

      if (quantity <= 0) {
        // IOC gets one chance; anything unfilled is cancelled rather than rested.
        if (request.timeInForce === 'IOC') {
          this.resting.delete(brokerOrderId);
          this.completed.set(brokerOrderId, {
            ...resting.order,
            status: resting.order.filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'CANCELLED',
            updatedAt: this.clock,
          });
        }
        continue;
      }

      const turnover = fromPaise(quantity * fillPrice);
      const costs = computeCosts(turnover, request.side, request.product, this.costSchedule);

      const fill: Fill = {
        orderId: brokerOrderId,
        symbol,
        side: request.side,
        quantity,
        price: fillPrice,
        timestamp: this.clock,
        commission: costs.total,
      };

      this.fills.push(fill);
      produced.push(fill);

      const filledQuantity = resting.order.filledQuantity + quantity;
      const previousNotional =
        (resting.order.averageFillPrice ?? 0) * resting.order.filledQuantity;
      const averageFillPrice = fromPaise(
        Math.round((previousNotional + quantity * fillPrice) / filledQuantity),
      );

      const updated: Order = {
        ...resting.order,
        status: filledQuantity >= request.quantity ? 'FILLED' : 'PARTIALLY_FILLED',
        filledQuantity,
        averageFillPrice,
        updatedAt: this.clock,
      };

      this.cash = fromPaise(
        this.cash + (request.side === 'BUY' ? -turnover : turnover) - costs.total,
      );

      if (updated.status === 'FILLED' || request.timeInForce === 'IOC') {
        this.resting.delete(brokerOrderId);
        this.completed.set(brokerOrderId, updated);
      } else {
        resting.order = updated;
      }

      for (const listener of this.listeners) listener(fill);
    }

    return produced;
  }

  /**
   * The price an order would fill at, or `null` if it would not fill.
   *
   * Limit orders require price to trade strictly through the limit — see the
   * class comment on why touching is not enough.
   */
  private resolveFillPrice(request: OrderRequest, price: Paise): Paise | null {
    switch (request.orderType) {
      case 'MARKET':
        return this.applySlippage(price, request.side);

      case 'LIMIT': {
        const limit = request.limitPrice!;
        if (request.side === 'BUY' && price < limit) return roundToTick(price, 'down');
        if (request.side === 'SELL' && price > limit) return roundToTick(price, 'up');
        return null;
      }

      case 'STOP': {
        const trigger = request.triggerPrice!;
        const triggered =
          request.side === 'BUY' ? price >= trigger : price <= trigger;
        // A stop becomes a market order once hit — and slips, which is exactly
        // when slippage is worst.
        return triggered ? this.applySlippage(price, request.side) : null;
      }

      case 'STOP_LIMIT': {
        const trigger = request.triggerPrice!;
        const limit = request.limitPrice!;
        const triggered = request.side === 'BUY' ? price >= trigger : price <= trigger;
        if (!triggered) return null;
        if (request.side === 'BUY' && price <= limit) return roundToTick(price, 'down');
        if (request.side === 'SELL' && price >= limit) return roundToTick(price, 'up');
        return null;
      }
    }
  }

  /** Moves the fill price against the order, then snaps to the tick grid. */
  private applySlippage(price: Paise, side: 'BUY' | 'SELL'): Paise {
    const drift = mulRate(price, this.slippageFraction);
    const slipped = fromPaise(side === 'BUY' ? price + drift : price - drift);
    return roundToTick(slipped, side === 'BUY' ? 'up' : 'down');
  }
}
