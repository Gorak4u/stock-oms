/**
 * One contract suite, run against both persistence implementations.
 *
 * The in-memory repositories exist so tests and backtests need no database.
 * That is only safe if they behave identically to Postgres — so the same suite
 * runs against both, and a divergence fails here rather than in production.
 *
 * The Postgres run is skipped when no database is reachable (set
 * `TEST_DATABASE_URL`), so the suite stays green on a machine without one
 * while still covering the real adapter in CI.
 */

import { execFileSync } from 'node:child_process';
import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Fill, Order } from '../src/domain/types';
import { InMemoryAuditLog } from '../src/audit/log';
import type { ClosedTrade } from '../src/execution/portfolio';
import { DuplicateKeyError, type Repositories } from '../src/persistence/ports';
import { memoryRepositories } from '../src/persistence/memory';
import { Database } from '../src/persistence/postgres';
import { announceUnavailable } from './support/infra';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading';

function order(overrides: Partial<Order> = {}, key = 'key-1'): Order {
  return {
    id: 'ord-' + key,
    request: {
      symbol: 'NSE:RELIANCE',
      side: 'BUY',
      quantity: 100,
      orderType: 'MARKET',
      product: 'MIS',
      timeInForce: 'DAY',
      strategyId: 'trend',
      idempotencyKey: key,
    },
    status: 'PENDING_NEW',
    filledQuantity: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    orderId: 'ord-key-1',
    symbol: 'NSE:RELIANCE',
    side: 'BUY',
    quantity: 40,
    price: fromRupees(2500),
    timestamp: 1_700_000_000_100,
    commission: fromRupees(20),
    ...overrides,
  };
}

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    symbol: 'NSE:RELIANCE',
    direction: 'LONG',
    quantity: 100,
    entryPrice: fromRupees(2500),
    exitPrice: fromRupees(2600),
    pnl: fromRupees(9_980),
    closedAt: 1_700_000_100_000,
    ...overrides,
  };
}

function candle(ts: number, close: number): Candle {
  return {
    symbol: 'NSE:RELIANCE',
    interval: '1d',
    timestamp: ts,
    open: fromRupees(close - 5),
    high: fromRupees(close + 10),
    low: fromRupees(close - 12),
    close: fromRupees(close),
    volume: 100_000,
  };
}

/** The suite both implementations must satisfy. */
function contractSuite(name: string, setup: () => Promise<Repositories>, teardown?: () => Promise<void>) {
  describe(name, () => {
    let repos: Repositories;

    beforeEach(async () => {
      repos = await setup();
    });

    afterAll(async () => {
      if (teardown) await teardown();
    });

    // ---- orders ----------------------------------------------------------
    describe('orders', () => {
      it('round-trips an order without losing any field', async () => {
        const original = order({
          brokerOrderId: 'broker-9',
          status: 'OPEN',
          filledQuantity: 40,
          averageFillPrice: fromRupees(2501.25),
        });
        await repos.orders.insert(original);

        const loaded = await repos.orders.findById(original.id);
        expect(loaded).toEqual(original);
      });

      it('preserves optional price fields when present and absent', async () => {
        const withPrices = order({
          id: 'ord-limit',
          request: { ...order().request, idempotencyKey: 'k-limit', orderType: 'STOP_LIMIT',
                     limitPrice: fromRupees(2510), triggerPrice: fromRupees(2505) },
        });
        await repos.orders.insert(withPrices);

        const loaded = await repos.orders.findById('ord-limit');
        expect(loaded!.request.limitPrice).toBe(fromRupees(2510));
        expect(loaded!.request.triggerPrice).toBe(fromRupees(2505));

        await repos.orders.insert(order({}, 'k-market'));
        const market = await repos.orders.findByIdempotencyKey('k-market');
        expect(market!.request.limitPrice).toBeUndefined();
      });

      it('refuses a duplicate idempotency key — the storage-level guarantee', async () => {
        await repos.orders.insert(order({}, 'dup'));
        await expect(
          repos.orders.insert(order({ id: 'ord-other' }, 'dup')),
        ).rejects.toThrow(DuplicateKeyError);
      });

      it('finds by idempotency key', async () => {
        await repos.orders.insert(order({}, 'findable'));
        const found = await repos.orders.findByIdempotencyKey('findable');
        expect(found!.request.idempotencyKey).toBe('findable');
        expect(await repos.orders.findByIdempotencyKey('missing')).toBeNull();
      });

      it('lists only non-terminal orders as open', async () => {
        await repos.orders.insert(order({ id: 'a', status: 'OPEN' }, 'a'));
        await repos.orders.insert(order({ id: 'b', status: 'PENDING_NEW' }, 'b'));
        await repos.orders.insert(order({ id: 'c', status: 'FILLED', filledQuantity: 100 }, 'c'));
        await repos.orders.insert(order({ id: 'd', status: 'CANCELLED' }, 'd'));
        await repos.orders.insert(order({ id: 'e', status: 'REJECTED' }, 'e'));

        const open = await repos.orders.findOpen();
        expect(open.map((o) => o.id).sort()).toEqual(['a', 'b']);
      });

      it('applies an update', async () => {
        const initial = order({}, 'upd');
        await repos.orders.insert(initial);
        await repos.orders.update({
          ...initial,
          status: 'FILLED',
          filledQuantity: 100,
          averageFillPrice: fromRupees(2499.95),
          brokerOrderId: 'broker-77',
          updatedAt: 1_700_000_500_000,
        });

        const loaded = await repos.orders.findById(initial.id);
        expect(loaded!.status).toBe('FILLED');
        expect(loaded!.averageFillPrice).toBe(fromRupees(2499.95));
        expect(loaded!.brokerOrderId).toBe('broker-77');
      });

      it('returns null for an unknown id', async () => {
        expect(await repos.orders.findById('nope')).toBeNull();
      });
    });

    // ---- fills -----------------------------------------------------------
    describe('fills', () => {
      beforeEach(async () => {
        await repos.orders.insert(order({}, 'key-1'));
      });

      it('stores a fill and reports it as newly stored', async () => {
        expect(await repos.fills.append(fill())).toBe(true);
        expect(await repos.fills.forOrder('ord-key-1')).toHaveLength(1);
      });

      it('ignores a replayed fill instead of doubling the position', async () => {
        await repos.fills.append(fill());
        expect(await repos.fills.append(fill())).toBe(false);
        expect(await repos.fills.forOrder('ord-key-1')).toHaveLength(1);
      });

      it('treats a genuinely different fill on the same order as new', async () => {
        await repos.fills.append(fill());
        expect(await repos.fills.append(fill({ timestamp: 1_700_000_000_200 }))).toBe(true);
        expect(await repos.fills.forOrder('ord-key-1')).toHaveLength(2);
      });

      it('filters by timestamp', async () => {
        await repos.fills.append(fill({ timestamp: 1000 }));
        await repos.fills.append(fill({ timestamp: 3000 }));
        expect(await repos.fills.since(2000)).toHaveLength(1);
      });

      it('round-trips price and commission exactly', async () => {
        await repos.fills.append(fill({ price: fromRupees(2500.05), commission: fromRupees(23.61) }));
        const [stored] = await repos.fills.forOrder('ord-key-1');
        expect(stored!.price).toBe(fromRupees(2500.05));
        expect(stored!.commission).toBe(fromRupees(23.61));
      });
    });

    // ---- trades ----------------------------------------------------------
    describe('trades', () => {
      it('round-trips a closed trade', async () => {
        await repos.trades.append(trade());
        const [stored] = await repos.trades.recent(10);
        expect(stored).toEqual(trade());
      });

      it('preserves a negative P&L sign', async () => {
        await repos.trades.append(trade({ pnl: fromRupees(-4_320.55) }));
        const [stored] = await repos.trades.recent(1);
        expect(stored!.pnl).toBe(fromRupees(-4_320.55));
      });

      it('orders recent newest-first and honours the limit', async () => {
        await repos.trades.append(trade({ closedAt: 1000 }));
        await repos.trades.append(trade({ closedAt: 3000 }));
        await repos.trades.append(trade({ closedAt: 2000 }));

        const recent = await repos.trades.recent(2);
        expect(recent.map((t) => t.closedAt)).toEqual([3000, 2000]);
      });

      it('filters a date range, ascending', async () => {
        await repos.trades.append(trade({ closedAt: 1000 }));
        await repos.trades.append(trade({ closedAt: 2000 }));
        await repos.trades.append(trade({ closedAt: 3000 }));

        const range = await repos.trades.between(1500, 3000);
        expect(range.map((t) => t.closedAt)).toEqual([2000, 3000]);
      });
    });

    // ---- positions -------------------------------------------------------
    describe('positions', () => {
      const position = {
        symbol: 'NSE:TCS',
        quantity: 50,
        averagePrice: fromRupees(3400),
        realisedPnl: fromRupees(1200),
        unrealisedPnl: fromRupees(2500),
        lastPrice: fromRupees(3450),
      };

      it('upserts rather than duplicating', async () => {
        await repos.positions.upsert(position, 1);
        await repos.positions.upsert({ ...position, quantity: 75 }, 2);

        const all = await repos.positions.all();
        expect(all).toHaveLength(1);
        expect(all[0]!.quantity).toBe(75);
      });

      it('recomputes unrealised P&L from the stored mark', async () => {
        await repos.positions.upsert(position, 1);
        const stored = await repos.positions.find('NSE:TCS');
        // 50 × (3450 − 3400)
        expect(stored!.unrealisedPnl).toBe(fromRupees(2500));
      });

      it('excludes flat positions from open', async () => {
        await repos.positions.upsert(position, 1);
        await repos.positions.upsert(
          { ...position, symbol: 'NSE:INFY', quantity: 0, unrealisedPnl: 0 as Paise }, 1,
        );

        expect(await repos.positions.open()).toHaveLength(1);
        expect(await repos.positions.all()).toHaveLength(2);
      });

      it('handles a short position', async () => {
        await repos.positions.upsert({ ...position, quantity: -50 }, 1);
        const stored = await repos.positions.find('NSE:TCS');
        expect(stored!.quantity).toBe(-50);
        expect(stored!.unrealisedPnl).toBe(fromRupees(-2500));
      });
    });

    // ---- equity ----------------------------------------------------------
    describe('equity', () => {
      const snapshot = {
        timestamp: 1000,
        equity: fromRupees(1_012_345.67),
        cash: fromRupees(500_000),
        realisedPnl: fromRupees(12_345.67),
        unrealisedPnl: fromRupees(-500.25),
      };

      it('round-trips a snapshot exactly', async () => {
        await repos.equity.append(snapshot);
        expect(await repos.equity.latest()).toEqual(snapshot);
      });

      it('overwrites on the same timestamp rather than duplicating', async () => {
        await repos.equity.append(snapshot);
        await repos.equity.append({ ...snapshot, equity: fromRupees(999) });
        const between = await repos.equity.between(0, 5000);
        expect(between).toHaveLength(1);
        expect(between[0]!.equity).toBe(fromRupees(999));
      });

      it('returns a range ascending', async () => {
        await repos.equity.append({ ...snapshot, timestamp: 3000 });
        await repos.equity.append({ ...snapshot, timestamp: 1000 });
        await repos.equity.append({ ...snapshot, timestamp: 2000 });

        expect((await repos.equity.between(0, 9000)).map((p) => p.timestamp)).toEqual([1000, 2000, 3000]);
      });

      it('returns null when empty', async () => {
        expect(await repos.equity.latest()).toBeNull();
      });
    });

    // ---- audit -----------------------------------------------------------
    describe('audit', () => {
      it('persists a hash chain that still verifies after a round trip', async () => {
        const log = new InMemoryAuditLog();
        const records = [
          log.append('SIGNAL_GENERATED', 'c1', { symbol: 'NSE:RELIANCE' }, 1),
          log.append('RISK_APPROVED', 'c1', { quantity: 100 }, 2),
          log.append('ORDER_SUBMITTED', 'c1', { orderId: 'ord-1' }, 3),
        ];
        for (const record of records) await repos.audit.append(record);

        const head = await repos.audit.head();
        expect(head!.sequence).toBe(3);
        expect(head!.hash).toBe(records[2]!.hash);

        // The chain must survive storage: each record still points at its
        // predecessor's hash after being written and read back.
        const journey = await repos.audit.byCorrelation('c1');
        expect(journey).toHaveLength(3);
        for (let i = 1; i < journey.length; i += 1) {
          expect(journey[i]!.previousHash).toBe(journey[i - 1]!.hash);
        }
      });

      it('preserves the payload structure', async () => {
        const log = new InMemoryAuditLog();
        const record = log.append(
          'RISK_REJECTED', 'c2',
          { reasons: ['DAILY_LOSS_LIMIT: breached'], nested: { quantity: 10 } }, 5,
        );
        await repos.audit.append(record);

        const [stored] = await repos.audit.byCorrelation('c2');
        expect(stored!.payload).toEqual(record.payload);
      });

      it('filters by type, newest first', async () => {
        const log = new InMemoryAuditLog();
        await repos.audit.append(log.append('RISK_REJECTED', 'a', {}, 1));
        await repos.audit.append(log.append('RISK_APPROVED', 'b', {}, 2));
        await repos.audit.append(log.append('RISK_REJECTED', 'c', {}, 3));

        const rejected = await repos.audit.byType('RISK_REJECTED', 10);
        expect(rejected).toHaveLength(2);
        expect(rejected[0]!.sequence).toBe(3);
      });

      it('returns null head when empty', async () => {
        expect(await repos.audit.head()).toBeNull();
      });
    });

    // ---- candles ---------------------------------------------------------
    describe('candles', () => {
      it('bulk upserts and reads a range ascending', async () => {
        await repos.candles.upsertMany([candle(3000, 2510), candle(1000, 2490), candle(2000, 2500)]);
        const range = await repos.candles.range('NSE:RELIANCE', '1d', 0, 9000);
        expect(range.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
        expect(range[1]!.close).toBe(fromRupees(2500));
      });

      it('lets corrected data replace an existing bar', async () => {
        await repos.candles.upsertMany([candle(1000, 2490)]);
        await repos.candles.upsertMany([candle(1000, 2495)]);

        const range = await repos.candles.range('NSE:RELIANCE', '1d', 0, 9000);
        expect(range).toHaveLength(1);
        expect(range[0]!.close).toBe(fromRupees(2495));
      });

      it('returns the latest N oldest-first, ready for indicator input', async () => {
        await repos.candles.upsertMany([
          candle(1000, 100), candle(2000, 200), candle(3000, 300), candle(4000, 400),
        ]);
        const latest = await repos.candles.latest('NSE:RELIANCE', '1d', 2);
        expect(latest.map((c) => c.timestamp)).toEqual([3000, 4000]);
      });

      it('handles an empty batch and unknown symbols', async () => {
        expect(await repos.candles.upsertMany([])).toBe(0);
        expect(await repos.candles.range('NOPE', '1d', 0, 9000)).toEqual([]);
        expect(await repos.candles.latest('NOPE', '1d', 5)).toEqual([]);
      });

      it('lists distinct symbols', async () => {
        await repos.candles.upsertMany([candle(1000, 100), { ...candle(1000, 100), symbol: 'NSE:TCS' }]);
        expect(await repos.candles.symbols()).toEqual(['NSE:RELIANCE', 'NSE:TCS']);
      });
    });

    // ---- models ----------------------------------------------------------
    describe('models', () => {
      const model = {
        id: 'signal-filter',
        version: '1',
        featureNames: ['rsi14', 'zScore20'],
        weights: [0.25, -0.5],
        bias: 0.1,
        metrics: { accuracy: 0.61, precision: 0.6, recall: 0.5, sampleCount: 1200, abstentionRate: 0.1 },
        promoted: false,
        registeredAt: 1000,
      };

      it('round-trips a model including its coefficients', async () => {
        await repos.models.save(model);
        const loaded = await repos.models.find('signal-filter', '1');
        expect(loaded!.weights).toEqual([0.25, -0.5]);
        expect(loaded!.bias).toBeCloseTo(0.1, 10);
        expect(loaded!.metrics!.accuracy).toBeCloseTo(0.61, 10);
      });

      it('has nothing promoted initially', async () => {
        await repos.models.save(model);
        expect(await repos.models.promoted()).toBeNull();
      });

      it('promotes exactly one model at a time', async () => {
        await repos.models.save(model);
        await repos.models.save({ ...model, version: '2', registeredAt: 2000 });

        await repos.models.promote('signal-filter', '1');
        expect((await repos.models.promoted())!.version).toBe('1');

        await repos.models.promote('signal-filter', '2');
        const promoted = await repos.models.promoted();
        expect(promoted!.version).toBe('2');
        expect((await repos.models.all()).filter((m) => m.promoted)).toHaveLength(1);
      });

      it('refuses to promote an unregistered model', async () => {
        await expect(repos.models.promote('ghost', '1')).rejects.toThrow();
      });

      it('demotes everything on request', async () => {
        await repos.models.save(model);
        await repos.models.promote('signal-filter', '1');
        await repos.models.demoteAll();
        expect(await repos.models.promoted()).toBeNull();
      });
    });

    // ---- runtime state ---------------------------------------------------
    describe('runtime state', () => {
      it('round-trips a structured value', async () => {
        await repos.state.set('automation', { mode: 'APPROVAL', changedBy: 'operator' }, 1);
        expect(await repos.state.get('automation')).toEqual({ mode: 'APPROVAL', changedBy: 'operator' });
      });

      it('overwrites on the same key', async () => {
        await repos.state.set('mode', 'MANUAL', 1);
        await repos.state.set('mode', 'AUTOMATIC', 2);
        expect(await repos.state.get('mode')).toBe('AUTOMATIC');
      });

      it('returns null for a missing key', async () => {
        expect(await repos.state.get('absent')).toBeNull();
      });

      it('is not aliased to the caller object', async () => {
        const value = { mode: 'MANUAL' };
        await repos.state.set('m', value, 1);
        value.mode = 'AUTOMATIC';
        expect(await repos.state.get('m')).toEqual({ mode: 'MANUAL' });
      });
    });

    // ---- reconciliation --------------------------------------------------
    describe('reconciliation', () => {
      it('records and lists open breaks', async () => {
        await repos.reconciliation.record({
          orderId: 'ord-1', detail: 'broker has no record', detectedAt: 1000,
        });
        const open = await repos.reconciliation.open();
        expect(open).toHaveLength(1);
        expect(open[0]!.detail).toBe('broker has no record');
      });

      it('drops a resolved break from the open list', async () => {
        await repos.reconciliation.record({ orderId: 'ord-1', detail: 'x', detectedAt: 1000 });
        const [entry] = await repos.reconciliation.open();
        await repos.reconciliation.resolve(entry!.id!, 'confirmed cancelled at broker', 2000);
        expect(await repos.reconciliation.open()).toHaveLength(0);
      });

      it('accepts a break with no order id', async () => {
        await repos.reconciliation.record({ orderId: null, detail: 'cash mismatch', detectedAt: 1 });
        expect(await repos.reconciliation.open()).toHaveLength(1);
      });
    });
  });
}

// ---------------------------------------------------------------------------

contractSuite('persistence contract — in-memory', async () => memoryRepositories());

/**
 * Whether to register the Postgres suite has to be decided synchronously, at
 * module load — Jest builds its test tree before any `beforeAll` runs, so an
 * async probe would come too late to skip cleanly. `pg_isready` is the cheap
 * synchronous answer.
 */
function postgresReachable(): boolean {
  try {
    const url = new URL(DATABASE_URL);
    execFileSync('pg_isready', [
      '-h', url.hostname,
      '-p', url.port || '5432',
      '-t', '2',
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const POSTGRES_AVAILABLE = postgresReachable();

if (!POSTGRES_AVAILABLE) {
  // Visible rather than silent: a skipped adapter suite should never look like
  // a passing one. Under REQUIRE_INFRA (which CI sets) it is a hard failure,
  // because the adapter suite is the only thing standing between a broken
  // query and production.
  announceUnavailable('Postgres', DATABASE_URL, 'the persistence adapter suite');
}

let database: Database | null = null;

if (POSTGRES_AVAILABLE) {
  contractSuite(
    'persistence contract — postgres',
    async () => {
      if (!database) {
        database = new Database(DATABASE_URL);
        await database.migrate();
      }
      // Truncate between cases so each starts from a known state; RESTART
      // IDENTITY keeps generated ids predictable across runs.
      await database.pool.query(`
        TRUNCATE trading.fill, trading."order", trading.closed_trade, trading.position,
                 trading.equity_point, trading.audit_record, trading.candle,
                 trading.model, trading.runtime_state, trading.reconciliation_break
        RESTART IDENTITY CASCADE`);
      return database.repositories();
    },
    async () => {
      if (database) {
        await database.close();
        database = null;
      }
    },
  );
} else {
  describe.skip('persistence contract — postgres', () => {
    it('requires a reachable database', () => undefined);
  });
}
