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
