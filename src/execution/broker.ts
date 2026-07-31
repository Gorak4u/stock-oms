/**
 * Broker abstraction.
 *
 * Everything above this interface — strategies, risk, the OMS — is broker
 * agnostic. Adding Zerodha, Upstox or a failover connector means implementing
 * {@link BrokerConnector}, not touching the execution path.
 *
 * The interface is deliberately narrow. Broker APIs differ wildly in their
 * extras (baskets, GTT, cover orders); modelling only the operations the OMS
 * genuinely needs keeps every connector honest and testable.
 */

import type { Fill, Order, OrderRequest } from '../domain/types';
import type { Paise } from '../domain/money';

export interface BrokerOrderAck {
  readonly brokerOrderId: string;
  readonly acceptedAt: number;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    /** Whether the same request may safely be retried. */
    readonly retryable: boolean,
    readonly brokerCode?: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/**
 * Raised when a submission's outcome is genuinely unknown — a timeout, a
 * dropped connection.
 *
 * Distinct from {@link BrokerError} because the response is different: a
 * rejected order can be retried, an *unknown* one must be reconciled against
 * the broker's order book first, or the retry places a duplicate.
 */
export class BrokerUncertainError extends Error {
  constructor(
    message: string,
    readonly idempotencyKey: string,
  ) {
    super(message);
    this.name = 'BrokerUncertainError';
  }
}

export interface BrokerConnector {
  readonly name: string;

  /** Places an order. Must reject rather than duplicate on a repeated idempotency key. */
  submit(request: OrderRequest): Promise<BrokerOrderAck>;

  cancel(brokerOrderId: string): Promise<void>;

  /** The broker's view of an order — the authority during reconciliation. */
  getOrder(brokerOrderId: string): Promise<Order | null>;

  /** Fills since a timestamp, for reconciliation and recovery. */
  getFills(since: number): Promise<Fill[]>;

  /** Broker-side funds, checked against the platform's own view. */
  getAvailableCash(): Promise<Paise>;

  /** Cheap liveness probe used by the failover supervisor. */
  isHealthy(): Promise<boolean>;
}

/**
 * Routes to a primary broker and falls back to a secondary when it is unhealthy.
 *
 * Failover applies to *new* submissions only. Orders already resting at the
 * primary stay there and must be reconciled against it — re-sending them to
 * the secondary would double the position, which is the exact accident
 * failover is supposed to prevent.
 */
export class FailoverBroker implements BrokerConnector {
  readonly name: string;
  private usingSecondary = false;

  constructor(
    private readonly primary: BrokerConnector,
    private readonly secondary: BrokerConnector,
  ) {
    this.name = `failover(${primary.name}→${secondary.name})`;
  }

  private get active(): BrokerConnector {
    return this.usingSecondary ? this.secondary : this.primary;
  }

  /** Probes the primary and switches. Returns the connector now in use. */
  async evaluateHealth(): Promise<BrokerConnector> {
    const primaryHealthy = await this.primary.isHealthy().catch(() => false);
    this.usingSecondary = !primaryHealthy;
    return this.active;
  }

  async submit(request: OrderRequest): Promise<BrokerOrderAck> {
    await this.evaluateHealth();
    return this.active.submit(request);
  }

  cancel(brokerOrderId: string): Promise<void> {
    return this.active.cancel(brokerOrderId);
  }

  getOrder(brokerOrderId: string): Promise<Order | null> {
    return this.active.getOrder(brokerOrderId);
  }

  /** Merges both brokers' fills — positions can straddle a failover. */
  async getFills(since: number): Promise<Fill[]> {
    const [primaryFills, secondaryFills] = await Promise.all([
      this.primary.getFills(since).catch(() => [] as Fill[]),
      this.secondary.getFills(since).catch(() => [] as Fill[]),
    ]);
    return [...primaryFills, ...secondaryFills].sort((a, b) => a.timestamp - b.timestamp);
  }

  getAvailableCash(): Promise<Paise> {
    return this.active.getAvailableCash();
  }

  async isHealthy(): Promise<boolean> {
    const [primaryHealthy, secondaryHealthy] = await Promise.all([
      this.primary.isHealthy().catch(() => false),
      this.secondary.isHealthy().catch(() => false),
    ]);
    return primaryHealthy || secondaryHealthy;
  }

  get isFailedOver(): boolean {
    return this.usingSecondary;
  }
}
