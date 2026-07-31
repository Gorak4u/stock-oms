import Redis from 'ioredis';
import { execFileSync } from 'node:child_process';
import { fromRupees, type Paise } from '../src/domain/money';
import type { OrderRequest } from '../src/domain/types';
import { BrokerError, BrokerUncertainError } from '../src/execution/broker';
import { mapKiteStatus, ZerodhaBroker } from '../src/execution/zerodhaBroker';
import { RedisQueue } from '../src/messaging/queue';
import {
  AlertManager,
  HealthMonitor,
  MetricsRegistry,
  type Alert,
} from '../src/monitoring/metrics';

// ===========================================================================
// Zerodha connector — failure classification is the point
// ===========================================================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function broker(fetchImpl: typeof fetch): ZerodhaBroker {
  return new ZerodhaBroker({
    apiKey: 'key',
    accessToken: 'token',
    fetchImpl,
    maxRequestsPerSecond: 1000,
  });
}

const REQUEST: OrderRequest = {
  symbol: 'NSE:RELIANCE',
  side: 'BUY',
  quantity: 100,
  orderType: 'MARKET',
  product: 'MIS',
  timeInForce: 'DAY',
  strategyId: 'trend',
  idempotencyKey: 'abcdef0123456789abcdef0123456789',
};

describe('mapKiteStatus', () => {
  it('maps Kite transient states onto OPEN', () => {
    expect(mapKiteStatus('PUT ORDER REQ RECEIVED', 0, 100)).toBe('OPEN');
    expect(mapKiteStatus('VALIDATION PENDING', 0, 100)).toBe('OPEN');
    expect(mapKiteStatus('TRIGGER PENDING', 0, 100)).toBe('OPEN');
  });

  it('maps terminal states', () => {
    expect(mapKiteStatus('COMPLETE', 100, 100)).toBe('FILLED');
    expect(mapKiteStatus('CANCELLED', 0, 100)).toBe('CANCELLED');
    expect(mapKiteStatus('REJECTED', 0, 100)).toBe('REJECTED');
  });

  it('detects a partial fill, which Kite reports as OPEN', () => {
    expect(mapKiteStatus('OPEN', 40, 100)).toBe('PARTIALLY_FILLED');
    expect(mapKiteStatus('OPEN', 0, 100)).toBe('OPEN');
    expect(mapKiteStatus('OPEN', 100, 100)).toBe('OPEN');
  });

  it('treats an unknown status as OPEN rather than inventing a terminal state', () => {
    expect(mapKiteStatus('SOMETHING NEW', 0, 100)).toBe('OPEN');
  });
});

describe('ZerodhaBroker — submission', () => {
  it('returns the broker order id on success', async () => {
    const b = broker(async () => jsonResponse({ status: 'success', data: { order_id: '2210' } }));
    const ack = await b.submit(REQUEST);
    expect(ack.brokerOrderId).toBe('2210');
  });

  it('sends the idempotency key as the Kite tag so a lost ack can be recovered', async () => {
    let sentBody = '';
    const b = broker(async (_url, init) => {
      sentBody = String(init?.body ?? '');
      return jsonResponse({ status: 'success', data: { order_id: '1' } });
    });

    await b.submit(REQUEST);
    expect(sentBody).toContain(`tag=${REQUEST.idempotencyKey.slice(0, 20)}`);
    expect(sentBody).toContain('tradingsymbol=RELIANCE');
    expect(sentBody).toContain('exchange=NSE');
  });

  it('translates stop order types to Kite SL / SL-M', async () => {
    let body = '';
    const b = broker(async (_url, init) => {
      body = String(init?.body ?? '');
      return jsonResponse({ status: 'success', data: { order_id: '1' } });
    });

    await b.submit({ ...REQUEST, orderType: 'STOP', triggerPrice: fromRupees(2400) });
    expect(body).toContain('order_type=SL-M');
    expect(body).toContain('trigger_price=2400.00');

    await b.submit({
      ...REQUEST, idempotencyKey: 'k2', orderType: 'STOP_LIMIT',
      triggerPrice: fromRupees(2400), limitPrice: fromRupees(2395),
    });
    expect(body).toContain('order_type=SL');
    expect(body).toContain('price=2395.00');
  });
});

describe('ZerodhaBroker — failure classification', () => {
  it('treats a rate limit as retryable', async () => {
    const b = broker(async () =>
      jsonResponse({ status: 'error', message: 'Too many requests', error_type: 'NetworkException' }, 429),
    );

    await expect(b.submit(REQUEST)).rejects.toMatchObject({
      name: 'BrokerError', retryable: true,
    });
  });

  it('treats insufficient margin as fatal, not retryable', async () => {
    const b = broker(async () =>
      jsonResponse({ status: 'error', message: 'Insufficient funds', error_type: 'MarginException' }, 400),
    );

    const error = await b.submit(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).retryable).toBe(false);
  });

  it('treats a network failure on submit as UNCERTAIN, never retryable', async () => {
    // The decisive case: a socket that dies mid-submit may still have reached
    // the exchange. Retrying would duplicate the position.
    const b = broker(async () => {
      throw new Error('socket hang up');
    });

    const error = await b.submit(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerUncertainError);
    expect((error as BrokerUncertainError).idempotencyKey).toBe(REQUEST.idempotencyKey);
  });

  it('treats a 5xx on submit as uncertain — the gateway may have failed after acceptance', async () => {
    const b = broker(async () => jsonResponse({ status: 'error', message: 'bad gateway' }, 502));
    await expect(b.submit(REQUEST)).rejects.toBeInstanceOf(BrokerUncertainError);
  });

  it('treats an unparseable submit response as uncertain', async () => {
    const b = broker(async () => new Response('<html>gateway timeout</html>', { status: 200 }));
    await expect(b.submit(REQUEST)).rejects.toBeInstanceOf(BrokerUncertainError);
  });

  it('treats the same failures on a READ as merely retryable', async () => {
    // A failed GET changes nothing at the exchange, so it is safe to repeat.
    const b = broker(async () => {
      throw new Error('socket hang up');
    });

    const error = await b.getOrder('123').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).retryable).toBe(true);
  });
});

describe('ZerodhaBroker — reads', () => {
  const kiteOrder = {
    order_id: '2210', status: 'COMPLETE', tradingsymbol: 'RELIANCE', exchange: 'NSE',
    transaction_type: 'BUY', quantity: 100, filled_quantity: 100, pending_quantity: 0,
    average_price: 2501.5, price: 0, trigger_price: 0, product: 'MIS', order_type: 'MARKET',
    validity: 'DAY', status_message: null, order_timestamp: '2026-03-02T10:00:00Z', tag: 'abc',
  };

  it('maps a completed order, converting rupees to paise', async () => {
    const b = broker(async () => jsonResponse({ status: 'success', data: [kiteOrder] }));
    const order = await b.getOrder('2210');

    expect(order!.status).toBe('FILLED');
    expect(order!.filledQuantity).toBe(100);
    expect(order!.averageFillPrice).toBe(fromRupees(2501.5));
    expect(order!.request.symbol).toBe('NSE:RELIANCE');
  });

  it('uses the last entry of the order history', async () => {
    const b = broker(async () =>
      jsonResponse({ status: 'success', data: [
        { ...kiteOrder, status: 'OPEN', filled_quantity: 0 },
        { ...kiteOrder, status: 'COMPLETE', filled_quantity: 100 },
      ] }),
    );
    expect((await b.getOrder('2210'))!.status).toBe('FILLED');
  });

  it('returns null for an empty history', async () => {
    const b = broker(async () => jsonResponse({ status: 'success', data: [] }));
    expect(await b.getOrder('2210')).toBeNull();
  });

  it('finds an order by tag — the recovery path for a lost submit response', async () => {
    const b = broker(async () => jsonResponse({ status: 'success', data: [kiteOrder] }));
    expect((await b.findByTag('abc'))!.brokerOrderId).toBe('2210');
    expect(await b.findByTag('missing')).toBeNull();
  });

  it('filters fills by timestamp', async () => {
    const b = broker(async () =>
      jsonResponse({ status: 'success', data: [
        { order_id: '1', tradingsymbol: 'RELIANCE', exchange: 'NSE', transaction_type: 'BUY',
          quantity: 50, average_price: 2500, fill_timestamp: '2026-03-02T10:00:00Z' },
        { order_id: '2', tradingsymbol: 'RELIANCE', exchange: 'NSE', transaction_type: 'SELL',
          quantity: 50, average_price: 2510, fill_timestamp: '2026-03-02T12:00:00Z' },
      ] }),
    );

    const fills = await b.getFills(Date.parse('2026-03-02T11:00:00Z'));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.side).toBe('SELL');
    expect(fills[0]!.price).toBe(fromRupees(2510));
  });

  it('reports health from the margins endpoint', async () => {
    const ok = broker(async () =>
      jsonResponse({ status: 'success', data: { equity: { available: { live_balance: 100 } } } }),
    );
    expect(await ok.isHealthy()).toBe(true);

    const down = broker(async () => {
      throw new Error('unreachable');
    });
    expect(await down.isHealthy()).toBe(false);
  });

  it('converts available cash to paise', async () => {
    const b = broker(async () =>
      jsonResponse({ status: 'success', data: { equity: { available: { live_balance: 125_000.5 } } } }),
    );
    expect(await b.getAvailableCash()).toBe(fromRupees(125_000.5));
  });
});

// ===========================================================================
// Redis queue — run against a live server when one is reachable
// ===========================================================================

function redisReachable(): boolean {
  try {
    execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', '6379', 'ping'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const REDIS_AVAILABLE = redisReachable();
if (!REDIS_AVAILABLE) {
  console.warn('Redis not reachable at 127.0.0.1:6379 — the queue suite is SKIPPED.');
}

(REDIS_AVAILABLE ? describe : describe.skip)('RedisQueue', () => {
  let redis: Redis;
  let queue: RedisQueue<{ order: string }>;

  beforeAll(() => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1 });
  });

  beforeEach(async () => {
    queue = new RedisQueue(redis, { name: `test-${Math.random().toString(36).slice(2)}`, maxAttempts: 3, backoffMs: 50 });
    await queue.drain();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('round-trips a job', async () => {
    await queue.enqueue({ order: 'ord-1' });
    const job = await queue.claim();

    expect(job!.payload).toEqual({ order: 'ord-1' });
    expect(job!.attempts).toBe(0);
  });

  it('returns null when empty', async () => {
    expect(await queue.claim()).toBeNull();
  });

  it('moves a claimed job to processing, not out of existence', async () => {
    await queue.enqueue({ order: 'ord-1' });
    await queue.claim();

    const depth = await queue.depth();
    expect(depth.ready).toBe(0);
    expect(depth.processing).toBe(1);
  });

  it('clears a completed job from processing', async () => {
    await queue.enqueue({ order: 'ord-1' });
    const job = await queue.claim();
    await queue.complete(job!);

    expect((await queue.depth()).processing).toBe(0);
  });

  it('retries with backoff, then dead-letters', async () => {
    await queue.enqueue({ order: 'ord-1' });

    let job = await queue.claim();
    expect(await queue.fail(job!, 'broker down')).toBe('retried');
    expect((await queue.depth()).delayed).toBe(1);

    // Not yet due.
    expect(await queue.claim()).toBeNull();

    await new Promise((r) => setTimeout(r, 80));
    job = await queue.claim();
    expect(job!.attempts).toBe(1);

    expect(await queue.fail(job!, 'still down')).toBe('retried');
    await new Promise((r) => setTimeout(r, 160));
    job = await queue.claim();
    expect(job!.attempts).toBe(2);

    // Third failure exhausts maxAttempts.
    expect(await queue.fail(job!, 'gave up')).toBe('dead');
    expect((await queue.depth()).dead).toBe(1);
  });

  it('keeps dead letters for an operator rather than dropping them', async () => {
    await queue.enqueue({ order: 'ord-doomed' });
    for (let i = 0; i < 3; i += 1) {
      await queue.promoteDelayed(Date.now() + 10_000);
      const job = await queue.claim(Date.now() + 10_000);
      await queue.fail(job!, 'nope');
    }

    const dead = await queue.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ reason: 'nope' });
  });

  it('honours an initial delay', async () => {
    await queue.enqueue({ order: 'later' }, undefined, 10_000);
    expect(await queue.claim()).toBeNull();
    expect(await queue.claim(Date.now() + 11_000)).not.toBeNull();
  });

  it('recovers a job abandoned by a dead worker', async () => {
    // The crash-safety guarantee: a worker that dies mid-job must not lose it.
    const shortLived = new RedisQueue<{ order: string }>(redis, {
      name: `abandon-${Math.random().toString(36).slice(2)}`,
      visibilityTimeoutMs: 50,
    });
    await shortLived.drain();

    await shortLived.enqueue({ order: 'ord-1' });
    await shortLived.claim();
    expect((await shortLived.depth()).processing).toBe(1);

    await new Promise((r) => setTimeout(r, 80));
    expect(await shortLived.recoverAbandoned()).toBe(1);

    const depth = await shortLived.depth();
    expect(depth.ready).toBe(1);
    expect(depth.processing).toBe(0);
    await shortLived.drain();
  });

  it('leaves a job that is still within its visibility timeout alone', async () => {
    await queue.enqueue({ order: 'ord-1' });
    await queue.claim();
    expect(await queue.recoverAbandoned()).toBe(0);
  });

  it('preserves FIFO order', async () => {
    await queue.enqueue({ order: 'first' });
    await queue.enqueue({ order: 'second' });

    expect((await queue.claim())!.payload.order).toBe('first');
    expect((await queue.claim())!.payload.order).toBe('second');
  });
});

// ===========================================================================
// Metrics, health, alerts
// ===========================================================================

describe('MetricsRegistry', () => {
  let metrics: MetricsRegistry;
  beforeEach(() => {
    metrics = new MetricsRegistry();
  });

  it('accumulates counters per label set', () => {
    metrics.increment('orders_total', { side: 'BUY' });
    metrics.increment('orders_total', { side: 'BUY' });
    metrics.increment('orders_total', { side: 'SELL' });

    const output = metrics.render();
    expect(output).toContain('orders_total{side="BUY"} 2');
    expect(output).toContain('orders_total{side="SELL"} 1');
  });

  it('overwrites gauges rather than accumulating', () => {
    metrics.setGauge('equity', 100);
    metrics.setGauge('equity', 250);
    expect(metrics.render()).toContain('equity 250');
  });

  it('renders histogram buckets cumulatively', () => {
    metrics.observe('latency', 0.02);
    metrics.observe('latency', 0.4);

    const output = metrics.render();
    expect(output).toContain('latency_bucket{le="0.025"} 1');
    expect(output).toContain('latency_bucket{le="0.5"} 2');
    expect(output).toContain('latency_bucket{le="+Inf"} 2');
    expect(output).toContain('latency_count 2');
  });

  it('emits HELP and TYPE lines', () => {
    metrics.describe('equity', 'gauge', 'Account equity in paise');
    metrics.setGauge('equity', 1);

    const output = metrics.render();
    expect(output).toContain('# HELP equity Account equity in paise');
    expect(output).toContain('# TYPE equity gauge');
  });

  it('escapes label values so output stays parseable', () => {
    metrics.increment('errors', { message: 'he said "no"' });
    expect(metrics.render()).toContain('message="he said \\"no\\""');
  });

  it('times a success and a failure separately', async () => {
    await metrics.time('op_seconds', { op: 'submit' }, async () => 'ok');
    await metrics
      .time('op_seconds', { op: 'submit' }, async () => {
        throw new Error('boom');
      })
      .catch(() => undefined);

    const output = metrics.render();
    expect(output).toContain('outcome="success"');
    expect(output).toContain('outcome="error"');
  });
});

describe('HealthMonitor', () => {
  it('is healthy when every check passes', async () => {
    const monitor = new HealthMonitor();
    monitor.register('db', async () => ({ status: 'healthy', detail: 'ok' }));
    monitor.register('broker', async () => ({ status: 'healthy', detail: 'ok' }));

    expect((await monitor.run()).status).toBe('healthy');
  });

  it('takes the worst individual result', async () => {
    const monitor = new HealthMonitor();
    monitor.register('db', async () => ({ status: 'healthy', detail: 'ok' }));
    monitor.register('broker', async () => ({ status: 'degraded', detail: 'slow' }));
    expect((await monitor.run()).status).toBe('degraded');

    monitor.register('redis', async () => ({ status: 'unhealthy', detail: 'down' }));
    expect((await monitor.run()).status).toBe('unhealthy');
  });

  it('treats a throwing check as unhealthy instead of propagating', async () => {
    const monitor = new HealthMonitor();
    monitor.register('broker', async () => {
      throw new Error('connection refused');
    });

    const report = await monitor.run();
    expect(report.status).toBe('unhealthy');
    expect(report.checks[0]!.detail).toContain('connection refused');
  });

  it('is healthy with no checks registered', async () => {
    expect((await new HealthMonitor().run()).status).toBe('healthy');
  });
});

describe('AlertManager', () => {
  function alert(overrides: Partial<Alert> = {}): Alert {
    return { severity: 'warning', title: 'Drawdown', detail: 'd', at: 1000, ...overrides };
  }

  it('delivers to every sink', async () => {
    const seen: string[] = [];
    const manager = new AlertManager();
    manager.addSink((a) => { seen.push(`a:${a.title}`); });
    manager.addSink((a) => { seen.push(`b:${a.title}`); });

    await manager.dispatch(alert());
    expect(seen).toEqual(['a:Drawdown', 'b:Drawdown']);
  });

  it('suppresses a repeat within the cooldown', async () => {
    let count = 0;
    const manager = new AlertManager(300_000);
    manager.addSink(() => { count += 1; });

    expect(await manager.dispatch(alert({ at: 1000 }))).toBe(true);
    expect(await manager.dispatch(alert({ at: 2000 }))).toBe(false);
    expect(count).toBe(1);
  });

  it('sends again once the cooldown expires', async () => {
    const manager = new AlertManager(1000);
    manager.addSink(() => undefined);

    expect(await manager.dispatch(alert({ at: 1000 }))).toBe(true);
    expect(await manager.dispatch(alert({ at: 2500 }))).toBe(true);
  });

  it('never suppresses a critical alert', async () => {
    // A silenced kill-switch alert is worse than a noisy one.
    const manager = new AlertManager(300_000);
    manager.addSink(() => undefined);

    expect(await manager.dispatch(alert({ severity: 'critical', at: 1000 }))).toBe(true);
    expect(await manager.dispatch(alert({ severity: 'critical', at: 1001 }))).toBe(true);
  });

  it('keeps delivering when one sink throws', async () => {
    let reached = false;
    const manager = new AlertManager();
    manager.addSink(() => { throw new Error('webhook down'); });
    manager.addSink(() => { reached = true; });

    await manager.dispatch(alert());
    expect(reached).toBe(true);
  });

  it('tracks cooldown per title, not globally', async () => {
    const manager = new AlertManager(300_000);
    manager.addSink(() => undefined);

    expect(await manager.dispatch(alert({ title: 'A', at: 1000 }))).toBe(true);
    expect(await manager.dispatch(alert({ title: 'B', at: 1001 }))).toBe(true);
  });
});
