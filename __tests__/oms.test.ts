import { fromRupees, type Paise } from '../src/domain/money';
import type { Fill, Order, OrderRequest } from '../src/domain/types';
import {
  BrokerError,
  BrokerUncertainError,
  type BrokerConnector,
  type BrokerOrderAck,
} from '../src/execution/broker';
import { canTransition, idempotencyKeyFor, OrderManager } from '../src/execution/oms';
import { InMemoryAuditLog } from '../src/audit/log';

class StubBroker implements BrokerConnector {
  readonly name = 'stub';
  submissions: OrderRequest[] = [];
  failWith: Error | null = null;
  private counter = 0;
  private orders = new Map<string, Order>();

  async submit(request: OrderRequest): Promise<BrokerOrderAck> {
    if (this.failWith) {
      const error = this.failWith;
      throw error;
    }
    this.submissions.push(request);
    this.counter += 1;
    const brokerOrderId = `broker-${this.counter}`;
    return { brokerOrderId, acceptedAt: 1 };
  }

  async cancel(): Promise<void> {}

  async getOrder(brokerOrderId: string): Promise<Order | null> {
    return this.orders.get(brokerOrderId) ?? null;
  }

  setRemoteOrder(brokerOrderId: string, order: Order): void {
    this.orders.set(brokerOrderId, order);
  }

  async getFills(): Promise<Fill[]> {
    return [];
  }

  async getAvailableCash(): Promise<Paise> {
    return fromRupees(100_000);
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}

const INTENT = {
  strategyId: 'momentum',
  symbol: 'NSE:RELIANCE',
  side: 'BUY' as const,
  quantity: 100,
  decisionBar: 1_700_000_000_000,
};

function makeOms(broker: BrokerConnector, audit?: InMemoryAuditLog) {
  return new OrderManager({ broker, ...(audit ? { audit } : {}), clock: () => 1_700_000_000_000 });
}

describe('idempotencyKeyFor', () => {
  it('is deterministic — the same intent always yields the same key', () => {
    expect(idempotencyKeyFor(INTENT)).toBe(idempotencyKeyFor({ ...INTENT }));
  });

  it('differs when any field of the intent differs', () => {
    const base = idempotencyKeyFor(INTENT);
    expect(idempotencyKeyFor({ ...INTENT, quantity: 101 })).not.toBe(base);
    expect(idempotencyKeyFor({ ...INTENT, side: 'SELL' })).not.toBe(base);
    expect(idempotencyKeyFor({ ...INTENT, decisionBar: INTENT.decisionBar + 1 })).not.toBe(base);
    expect(idempotencyKeyFor({ ...INTENT, symbol: 'NSE:TCS' })).not.toBe(base);
    expect(idempotencyKeyFor({ ...INTENT, strategyId: 'trend' })).not.toBe(base);
  });
});

describe('OrderManager — duplicate prevention', () => {
  it('sends the same intent to the broker exactly once', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    const request = oms.buildRequest(INTENT, {
      orderType: 'MARKET',
      product: 'MIS',
      timeInForce: 'DAY',
    });

    const first = await oms.submit(request, 'corr-1');
    const second = await oms.submit(request, 'corr-1');

    expect(first.submitted).toBe(true);
    expect(second.submitted).toBe(false);
    expect(second.refusedReason).toContain('duplicate');
    expect(broker.submissions).toHaveLength(1);
  });

  it('refuses the duplicate locally, without a broker round trip', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    const request = oms.buildRequest(INTENT, {
      orderType: 'MARKET',
      product: 'MIS',
      timeInForce: 'DAY',
    });

    await oms.submit(request, 'corr-1');
    broker.failWith = new BrokerError('broker should not have been called', false);

    const second = await oms.submit(request, 'corr-1');
    expect(second.submitted).toBe(false);
    expect(second.order.status).toBe('OPEN');
  });

  it('lets a genuinely new decision through on the next bar', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);

    await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'c1',
    );
    await oms.submit(
      oms.buildRequest(
        { ...INTENT, decisionBar: INTENT.decisionBar + 60_000 },
        { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' },
      ),
      'c2',
    );

    expect(broker.submissions).toHaveLength(2);
  });
});

describe('OrderManager — failure handling', () => {
  it('retries a retryable broker error', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    let calls = 0;

    const original = broker.submit.bind(broker);
    broker.submit = async (request) => {
      calls += 1;
      if (calls === 1) throw new BrokerError('rate limited', true);
      return original(request);
    };

    const result = await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    expect(result.submitted).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not retry a non-retryable error', async () => {
    const broker = new StubBroker();
    broker.failWith = new BrokerError('insufficient margin', false);
    const oms = makeOms(broker);

    const result = await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    expect(result.submitted).toBe(false);
    expect(result.order.status).toBe('REJECTED');
    expect(result.order.rejectionReason).toContain('insufficient margin');
  });

  it('leaves an uncertain submission PENDING_NEW instead of retrying into a duplicate', async () => {
    const broker = new StubBroker();
    broker.failWith = new BrokerUncertainError('gateway timeout', 'key');
    const audit = new InMemoryAuditLog();
    const oms = makeOms(broker, audit);

    const result = await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    expect(result.submitted).toBe(false);
    expect(result.order.status).toBe('PENDING_NEW');
    expect(audit.byType('RECONCILIATION_BREAK')).toHaveLength(1);
  });
});

describe('OrderManager — fills', () => {
  async function submitted() {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    const result = await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );
    return { oms, broker, orderId: result.order.id };
  }

  it('marks an order partially filled then filled', async () => {
    const { oms, orderId } = await submitted();

    let order = oms.applyFill(
      {
        orderId,
        symbol: INTENT.symbol,
        side: 'BUY',
        quantity: 40,
        price: fromRupees(2500),
        timestamp: 1,
        commission: 0 as Paise,
      },
      'corr',
    );
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity).toBe(40);

    order = oms.applyFill(
      {
        orderId,
        symbol: INTENT.symbol,
        side: 'BUY',
        quantity: 60,
        price: fromRupees(2600),
        timestamp: 2,
        commission: 0 as Paise,
      },
      'corr',
    );
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity).toBe(100);
    // Quantity-weighted: (40×2500 + 60×2600) / 100 = 2560
    expect(order.averageFillPrice).toBe(fromRupees(2560));
  });

  it('ignores a replayed fill rather than double-counting it', async () => {
    const { oms, orderId } = await submitted();
    const fill = {
      orderId,
      symbol: INTENT.symbol,
      side: 'BUY' as const,
      quantity: 40,
      price: fromRupees(2500),
      timestamp: 1,
      commission: 0 as Paise,
    };

    oms.applyFill(fill, 'corr');
    const order = oms.applyFill(fill, 'corr');

    expect(order.filledQuantity).toBe(40);
  });
});

describe('OrderManager — state machine', () => {
  it('forbids transitions out of a terminal state', () => {
    expect(canTransition('FILLED', 'OPEN')).toBe(false);
    expect(canTransition('CANCELLED', 'FILLED')).toBe(false);
    expect(canTransition('REJECTED', 'OPEN')).toBe(false);
  });

  it('allows the normal forward path', () => {
    expect(canTransition('PENDING_NEW', 'OPEN')).toBe(true);
    expect(canTransition('OPEN', 'PARTIALLY_FILLED')).toBe(true);
    expect(canTransition('PARTIALLY_FILLED', 'FILLED')).toBe(true);
  });
});

describe('OrderManager — reconciliation', () => {
  it('adopts the broker view when the two disagree', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    const result = await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    broker.setRemoteOrder('broker-1', {
      ...result.order,
      status: 'FILLED',
      filledQuantity: 100,
      averageFillPrice: fromRupees(2500),
    });

    const report = await oms.reconcile();
    expect(report.resolved).toBe(1);
    expect(oms.getOrder(result.order.id)!.status).toBe('FILLED');
  });

  it('flags a PENDING_NEW order with no broker id for manual review', async () => {
    const broker = new StubBroker();
    broker.failWith = new BrokerUncertainError('timeout', 'key');
    const oms = makeOms(broker);
    await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    const report = await oms.reconcile();
    expect(report.breaks).toHaveLength(1);
    expect(report.breaks[0]!.detail).toContain('verify manually');
  });

  it('reports an order the broker has never heard of', async () => {
    const broker = new StubBroker();
    const oms = makeOms(broker);
    await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );

    const report = await oms.reconcile();
    expect(report.breaks[0]!.detail).toContain('no record');
  });
});

describe('OrderManager — rate tracking', () => {
  it('drops submissions older than a minute', async () => {
    const broker = new StubBroker();
    let now = 1_700_000_000_000;
    const oms = new OrderManager({ broker, clock: () => now });

    await oms.submit(
      oms.buildRequest(INTENT, { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' }),
      'corr',
    );
    expect(oms.recentSubmissions(now)).toHaveLength(1);

    now += 61_000;
    expect(oms.recentSubmissions(now)).toHaveLength(0);
  });
});
