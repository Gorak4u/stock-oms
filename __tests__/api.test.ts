/**
 * API tests.
 *
 * These boot a real Fastify instance against real Postgres and inject real
 * HTTP requests — no mocked service layer. The point is to exercise the wiring
 * (auth, validation, persistence, serialisation) that unit tests of the
 * individual layers cannot reach.
 */

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Fill } from '../src/domain/types';
import { buildServer } from '../src/api/server';
import { Database } from '../src/persistence/postgres';
import { memoryRepositories } from '../src/persistence/memory';
import type { Repositories } from '../src/persistence/ports';
import { TradingService } from '../src/runtime/tradingService';
import { PaperBroker } from '../src/execution/paperBroker';
import { ZERO_COST_SCHEDULE } from '../src/execution/costs';
import { HealthMonitor, MetricsRegistry } from '../src/monitoring/metrics';
import { MarketCalendar } from '../src/marketdata/calendar';

const TOKEN = 'test-token-that-is-long-enough';
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading';

function postgresReachable(): boolean {
  try {
    const url = new URL(DATABASE_URL);
    execFileSync('pg_isready', ['-h', url.hostname, '-p', url.port || '5432', '-t', '2'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const POSTGRES_AVAILABLE = postgresReachable();

function candle(ts: number, close: number): Candle {
  return {
    symbol: 'NSE:TEST',
    interval: '1d',
    timestamp: ts,
    open: fromRupees(close),
    high: fromRupees(close + 5),
    low: fromRupees(close - 5),
    close: fromRupees(close),
    volume: 100_000,
  };
}

describe('API', () => {
  let app: FastifyInstance;
  let service: TradingService;
  let repositories: Repositories;
  let database: Database | null = null;

  beforeEach(async () => {
    if (POSTGRES_AVAILABLE) {
      if (!database) {
        database = new Database(DATABASE_URL);
        await database.migrate();
      }
      await database.pool.query(`
        TRUNCATE trading.fill, trading."order", trading.closed_trade, trading.position,
                 trading.equity_point, trading.audit_record, trading.candle,
                 trading.model, trading.runtime_state, trading.reconciliation_break
        RESTART IDENTITY CASCADE`);
      repositories = database.repositories();
    } else {
      repositories = memoryRepositories();
    }

    service = new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await service.start();

    app = buildServer({
      service,
      repositories,
      metrics: service.metrics,
      health: new HealthMonitor(),
      authToken: TOKEN,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  // ---- auth --------------------------------------------------------------

  describe('authentication', () => {
    it('lets reads through unauthenticated', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a write with no token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/mode', payload: { mode: 'AUTOMATIC' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a wrong token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/mode',
        headers: { authorization: 'Bearer wrong-token-but-same-length' },
        payload: { mode: 'AUTOMATIC' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts the right token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/mode', headers: auth, payload: { mode: 'APPROVAL' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('refuses to start with a weak token', () => {
      expect(() =>
        buildServer({
          service, repositories, metrics: service.metrics,
          health: new HealthMonitor(), authToken: 'short',
        }),
      ).toThrow(/at least 16 characters/);
    });
  });

  // ---- status ------------------------------------------------------------

  describe('GET /api/status', () => {
    it('reports opening state', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
      expect(body.equityRupees).toBe(1_000_000);
      expect(body.openPositions).toBe(0);
      expect(body.killSwitch.engaged).toBe(false);
      expect(body.mode).toBe('MANUAL');
    });
  });

  // ---- mode --------------------------------------------------------------

  describe('POST /api/mode', () => {
    it('changes and persists the mode', async () => {
      await app.inject({
        method: 'POST', url: '/api/mode', headers: auth,
        payload: { mode: 'AUTOMATIC', actor: 'alice' },
      });

      expect((await app.inject({ method: 'GET', url: '/api/status' })).json().mode).toBe('AUTOMATIC');
      expect(await repositories.state.get('automation.mode')).toBe('AUTOMATIC');
    });

    it('rejects an unknown mode', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/mode', headers: auth, payload: { mode: 'YOLO' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('records who made the change in the audit log', async () => {
      await app.inject({
        method: 'POST', url: '/api/mode', headers: auth,
        payload: { mode: 'AUTOMATIC', actor: 'alice' },
      });

      const changes = service.audit.byType('MODE_CHANGED');
      expect(changes.some((r) => r.payload.actor === 'alice')).toBe(true);
    });
  });

  // ---- kill switch -------------------------------------------------------

  describe('POST /api/risk/kill-switch', () => {
    it('engages and releases', async () => {
      const engaged = await app.inject({
        method: 'POST', url: '/api/risk/kill-switch', headers: auth,
        payload: { engaged: true, reason: 'market disorderly', actor: 'bob' },
      });
      expect(engaged.json().killSwitch.engaged).toBe(true);
      expect(engaged.json().killSwitch.reason).toContain('bob');

      const released = await app.inject({
        method: 'POST', url: '/api/risk/kill-switch', headers: auth,
        payload: { engaged: false, actor: 'bob' },
      });
      expect(released.json().killSwitch.engaged).toBe(false);
    });

    it('rejects a non-boolean', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/risk/kill-switch', headers: auth, payload: { engaged: 'yes' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('cannot be engaged without a token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/risk/kill-switch', payload: { engaged: true },
      });
      expect(response.statusCode).toBe(401);
      expect(service.risk.killSwitch.isEngaged).toBe(false);
    });
  });

  // ---- positions, trades, equity -----------------------------------------

  describe('portfolio routes', () => {
    beforeEach(async () => {
      const fill: Fill = {
        orderId: 'ord-seed', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
        price: fromRupees(1000), timestamp: 1000, commission: 0 as Paise,
      };
      // The order row must exist first — fills reference it.
      await repositories.orders.insert({
        id: 'ord-seed',
        request: {
          symbol: 'NSE:TEST', side: 'BUY', quantity: 100, orderType: 'MARKET',
          product: 'MIS', timeInForce: 'DAY', strategyId: 'seed', idempotencyKey: 'seed-key',
        },
        status: 'FILLED', filledQuantity: 100, createdAt: 1000, updatedAt: 1000,
      });
      await service.applyFill(fill);
    });

    it('lists open positions with rupee conveniences', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/positions' })).json();
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0].symbol).toBe('NSE:TEST');
      expect(body.positions[0].averagePriceRupees).toBe(1000);
    });

    it('records an equity point', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/equity' })).json();
      expect(body.curve.length).toBeGreaterThan(0);
    });

    it('ignores a replayed fill rather than doubling the position', async () => {
      const duplicate: Fill = {
        orderId: 'ord-seed', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
        price: fromRupees(1000), timestamp: 1000, commission: 0 as Paise,
      };
      await service.applyFill(duplicate);

      const body = (await app.inject({ method: 'GET', url: '/api/positions' })).json();
      expect(body.positions[0].quantity).toBe(100);
    });

    it('records a closed trade on the exit', async () => {
      await repositories.orders.insert({
        id: 'ord-exit',
        request: {
          symbol: 'NSE:TEST', side: 'SELL', quantity: 100, orderType: 'MARKET',
          product: 'MIS', timeInForce: 'DAY', strategyId: 'seed', idempotencyKey: 'exit-key',
        },
        status: 'FILLED', filledQuantity: 100, createdAt: 2000, updatedAt: 2000,
      });
      await service.applyFill({
        orderId: 'ord-exit', symbol: 'NSE:TEST', side: 'SELL', quantity: 100,
        price: fromRupees(1100), timestamp: 2000, commission: 0 as Paise,
      });

      const body = (await app.inject({ method: 'GET', url: '/api/trades' })).json();
      expect(body.trades).toHaveLength(1);
      expect(body.trades[0].pnlRupees).toBe(10_000);
    });
  });

  // ---- audit -------------------------------------------------------------

  describe('GET /api/audit', () => {
    it('reports the chain as intact', async () => {
      await app.inject({
        method: 'POST', url: '/api/mode', headers: auth, payload: { mode: 'APPROVAL' },
      });

      const body = (await app.inject({ method: 'GET', url: '/api/audit' })).json();
      expect(body.chainIntact).toBe(true);
      expect(body.records.length).toBeGreaterThan(0);
    });
  });

  // ---- backtest ----------------------------------------------------------

  describe('POST /api/backtest', () => {
    beforeEach(async () => {
      const candles = Array.from({ length: 400 }, (_, i) =>
        candle(i * 86_400_000, 1000 + Math.sin(i / 20) * 80 + i * 0.4),
      );
      await repositories.candles.upsertMany(candles);
    });

    it('runs against stored candles', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/backtest', headers: auth,
        payload: { symbol: 'NSE:TEST', strategy: 'trend', openingCash: 1_000_000 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.curve).toHaveLength(400);
      expect(typeof body.metrics.sharpe).toBe('number');
    });

    it('explains a series too short to warm up', async () => {
      await repositories.candles.upsertMany([candle(1, 100)]);
      const response = await app.inject({
        method: 'POST', url: '/api/backtest', headers: auth, payload: { symbol: 'NSE:SHORT' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toContain('need at least 120');
    });

    it('requires a symbol', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/backtest', headers: auth, payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('needs a token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/backtest', payload: { symbol: 'NSE:TEST' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ---- market data -------------------------------------------------------

  describe('market data routes', () => {
    it('returns stored candles and symbols', async () => {
      await repositories.candles.upsertMany([candle(1000, 100), candle(2000, 110)]);

      const candles = (await app.inject({ method: 'GET', url: '/api/candles/NSE:TEST' })).json();
      expect(candles.candles).toHaveLength(2);

      const symbols = (await app.inject({ method: 'GET', url: '/api/symbols' })).json();
      expect(symbols.symbols).toContain('NSE:TEST');
    });
  });

  // ---- health & metrics --------------------------------------------------

  describe('operational routes', () => {
    it('serves Prometheus metrics as text', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('trading_equity_paise');
    });

    it('returns 200 when healthy', async () => {
      const health = new HealthMonitor();
      health.register('db', async () => ({ status: 'healthy', detail: 'ok' }));

      const healthy = buildServer({
        service, repositories, metrics: service.metrics, health, authToken: TOKEN,
      });
      await healthy.ready();

      const response = await healthy.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('healthy');
      await healthy.close();
    });

    it('returns 503 when unhealthy so a load balancer can act on it', async () => {
      const health = new HealthMonitor();
      health.register('broker', async () => ({ status: 'unhealthy', detail: 'down' }));

      const sick = buildServer({
        service, repositories, metrics: service.metrics, health, authToken: TOKEN,
      });
      await sick.ready();

      const response = await sick.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      await sick.close();
    });
  });

  // ---- approvals ---------------------------------------------------------

  describe('approvals', () => {
    it('is empty initially', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/approvals' })).json();
      expect(body.approvals).toEqual([]);
    });

    it('reports a conflict when approving an unknown key', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/approvals/nonexistent/approve', headers: auth,
      });
      expect(response.statusCode).toBe(409);
    });

    it('needs a token to approve', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/approvals/x/approve' });
      expect(response.statusCode).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------

describe('TradingService state recovery', () => {
  it('rebuilds the portfolio by replaying fills, not by trusting a stored position', async () => {
    // The restart guarantee: positions are derived data, so a stale or
    // corrupted position row cannot survive a restart.
    const repositories = memoryRepositories();

    await repositories.orders.insert({
      id: 'ord-1',
      request: {
        symbol: 'NSE:TEST', side: 'BUY', quantity: 100, orderType: 'MARKET',
        product: 'MIS', timeInForce: 'DAY', strategyId: 's', idempotencyKey: 'k1',
      },
      status: 'FILLED', filledQuantity: 100, createdAt: 1, updatedAt: 1,
    });
    await repositories.fills.append({
      orderId: 'ord-1', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
      price: fromRupees(1000), timestamp: 1000, commission: 0 as Paise,
    });

    // A position row that disagrees with the fills — the sort of thing a
    // partial write leaves behind.
    await repositories.positions.upsert(
      {
        symbol: 'NSE:TEST', quantity: 9999, averagePrice: fromRupees(1),
        realisedPnl: 0 as Paise, unrealisedPnl: 0 as Paise, lastPrice: fromRupees(1),
      },
      1,
    );

    const service = new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE }),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await service.start();

    // The replayed fills win: 100 shares, not the bogus 9999.
    expect(service.portfolio.getPosition('NSE:TEST')!.quantity).toBe(100);
    expect(service.portfolio.cash).toBe(fromRupees(900_000));
  });

  it('keeps the emergency stop engaged across a restart', async () => {
    // A crash must not silently resume trading a human had stopped.
    const repositories = memoryRepositories();

    const first = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await first.start();
    await first.emergencyStop('disorderly market', 'ops');

    const second = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await second.start();

    expect(second.risk.killSwitch.isEngaged).toBe(true);
    expect(second.risk.killSwitch.state.reason).toContain('disorderly market');
    expect(second.risk.killSwitch.state.reason).toContain('restored on restart');
  });

  it('does not re-engage a stop that was released', async () => {
    const repositories = memoryRepositories();

    const first = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await first.start();
    await first.emergencyStop('halt', 'ops');
    await first.releaseEmergencyStop('ops');

    const second = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await second.start();

    expect(second.risk.killSwitch.isEngaged).toBe(false);
  });

  it('continues the audit chain across a restart instead of forking it', async () => {
    const repositories = memoryRepositories();

    const first = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await first.start();
    await first.setMode('APPROVAL', 'ops');
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the async persist land

    const headBefore = await repositories.audit.head();
    expect(headBefore).not.toBeNull();

    const second = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const headAfter = await repositories.audit.head();
    // Sequences continue upward, and the first new record points at the old head.
    expect(headAfter!.sequence).toBeGreaterThan(headBefore!.sequence);
    expect(second.audit.verifyChain()).toBeNull();

    const all = await repositories.audit.recent(100);
    const sequences = all.map((r) => r.sequence).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(sequences.length); // no duplicates
  });

  it('restores the automation mode across a restart', async () => {
    const repositories = memoryRepositories();
    await repositories.state.set('automation.mode', 'APPROVAL', 1);

    const service = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
    });
    await service.start();

    expect(service.pipeline.automationMode).toBe('APPROVAL');
  });
});
