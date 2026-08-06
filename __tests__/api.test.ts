/**
 * API tests.
 *
 * These boot a real Fastify instance against real Postgres and inject real
 * HTTP requests — no mocked service layer. The point is to exercise the wiring
 * (auth, validation, persistence, serialisation) that unit tests of the
 * individual layers cannot reach.
 */

import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
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
import { announceUnavailable } from './support/infra';

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

if (!POSTGRES_AVAILABLE) {
  // These tests still run against in-memory repositories, which is useful
  // locally but is not the thing being verified: the point of this suite is the
  // wiring against a real database. Under REQUIRE_INFRA the quiet downgrade is
  // a failure.
  announceUnavailable('Postgres', DATABASE_URL, 'the API suite against a real database');
}

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

  /** An authenticated GET. Reads require a token unless `publicReads` is set. */
  const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

  // ---- auth --------------------------------------------------------------

  describe('authentication', () => {
    it('rejects a read with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      expect(response.statusCode).toBe(401);
    });

    it('accepts a read with a token', async () => {
      const response = await get('/api/status');
      expect(response.statusCode).toBe(200);
    });

    it.each([
      '/api/positions', '/api/orders', '/api/trades', '/api/equity',
      '/api/audit', '/api/risk', '/api/reconciliation', '/api/symbols',
    ])('requires a token for %s', async (url) => {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    });

    it('serves the backtest console from the same process', async () => {
      // One application: the console is the platform core compiled for the
      // browser, not a separate product to host elsewhere. A 404 here means
      // `npm run build` did not produce dist/console.html.
      const response = await app.inject({ method: 'GET', url: '/console' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.body).toMatch(/backtest/i);
    });

    it('serves the dashboard shell without a token', async () => {
      // A browser cannot set an Authorization header when you navigate to a
      // URL, so guarding this would make the dashboard impossible to open at
      // all. The shell holds no data — every figure arrives through the
      // authenticated /api routes.
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('the dashboard shell discloses no account data', async () => {
      // The guarantee that makes serving it unauthenticated acceptable.
      const body = (await app.inject({ method: 'GET', url: '/' })).body;
      expect(body).not.toContain(TOKEN);
      expect(body).toMatch(/id="token"/);
    });

    it('leaves health and metrics open for infrastructure probes', async () => {
      // Injected without a token on purpose: the container healthcheck and the
      // metrics scraper have none, and neither route discloses account data.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    });

    it('serves reads unauthenticated when publicReads is set', async () => {
      const open = buildServer({
        service,
        repositories,
        metrics: service.metrics,
        health: new HealthMonitor(),
        authToken: TOKEN,
        publicReads: true,
      });
      await open.ready();
      try {
        expect((await open.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
        // Writes stay guarded regardless — publicReads is about disclosure,
        // not about who may move money.
        const write = await open.inject({
          method: 'POST', url: '/api/mode', payload: { mode: 'AUTOMATIC' },
        });
        expect(write.statusCode).toBe(401);
      } finally {
        await open.close();
      }
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
      const body = (await get('/api/status')).json();
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

      expect((await get('/api/status')).json().mode).toBe('AUTOMATIC');
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
      const body = (await get('/api/positions')).json();
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0].symbol).toBe('NSE:TEST');
      expect(body.positions[0].averagePriceRupees).toBe(1000);
    });

    it('records an equity point', async () => {
      const body = (await get('/api/equity')).json();
      expect(body.curve.length).toBeGreaterThan(0);
    });

    it('ignores a replayed fill rather than doubling the position', async () => {
      const duplicate: Fill = {
        orderId: 'ord-seed', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
        price: fromRupees(1000), timestamp: 1000, commission: 0 as Paise,
      };
      await service.applyFill(duplicate);

      const body = (await get('/api/positions')).json();
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

      const body = (await get('/api/trades')).json();
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

      const body = (await get('/api/audit')).json();
      expect(body.chainIntact).toBe(true);
      expect(body.records.length).toBeGreaterThan(0);
    });
  });

  // ---- cors --------------------------------------------------------------

  describe('CORS', () => {
    const CDN = 'https://stock-oms.vercel.app';

    function withCors(origins: string[]): FastifyInstance {
      return buildServer({
        service, repositories, metrics: service.metrics,
        health: new HealthMonitor(), authToken: TOKEN,
        corsOrigins: origins,
      });
    }

    it('sends no allow-origin header when no origins are configured', async () => {
      // Default-deny: a browser on another origin cannot read the API at all
      // unless someone deliberately allowed it.
      const response = await app.inject({
        method: 'GET', url: '/api/status', headers: { ...auth, origin: CDN },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('permits the Authorization header on preflight', async () => {
      // Every route authenticates with a bearer token, so a preflight that does
      // not permit Authorization fails every cross-origin read while looking
      // like a network fault.
      const server = withCors([CDN]);
      await server.ready();

      try {
        const response = await server.inject({
          method: 'OPTIONS', url: '/api/status',
          headers: {
            origin: CDN,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'authorization',
          },
        });

        expect(response.statusCode).toBeLessThan(300);
        expect(response.headers['access-control-allow-origin']).toBe(CDN);
        expect(String(response.headers['access-control-allow-headers']).toLowerCase())
          .toContain('authorization');
      } finally {
        await server.close();
      }
    });

    it('allows a configured origin and refuses an unconfigured one', async () => {
      const server = withCors([CDN]);
      await server.ready();

      try {
        const allowed = await server.inject({
          method: 'GET', url: '/api/status', headers: { ...auth, origin: CDN },
        });
        expect(allowed.headers['access-control-allow-origin']).toBe(CDN);

        const refused = await server.inject({
          method: 'GET', url: '/api/status',
          headers: { ...auth, origin: 'https://evil.example' },
        });
        expect(refused.headers['access-control-allow-origin']).not.toBe('https://evil.example');
      } finally {
        await server.close();
      }
    });

    it('does not let an allowed origin bypass authentication', async () => {
      // CORS decides which origin may *read a response*; it is not a grant of
      // access. An allowed origin with no token must still be refused.
      const server = withCors([CDN]);
      await server.ready();

      try {
        const response = await server.inject({
          method: 'GET', url: '/api/status', headers: { origin: CDN },
        });
        expect(response.statusCode).toBe(401);
      } finally {
        await server.close();
      }
    });

    it('does not allow credentialed requests', async () => {
      // The token travels in a header, not a cookie. Allowing credentials would
      // widen what a hostile page could do with an existing session for nothing.
      const server = withCors([CDN]);
      await server.ready();

      try {
        const response = await server.inject({
          method: 'GET', url: '/api/status', headers: { ...auth, origin: CDN },
        });
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });

  // ---- websocket ---------------------------------------------------------

  describe('WS /ws', () => {
    /**
     * Connects for real rather than via `inject`, which cannot do websockets.
     *
     * Resolves with the first frame, or with the handshake error — which is the
     * assertion that matters here: an unauthorised client must be refused the
     * upgrade outright, not handed a socket that is then closed.
     */
    function connect(url: string): Promise<{ frame?: unknown; error?: string }> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error('timed out waiting for a frame'));
        }, 5000);

        let settled = false;
        const finish = (result: { frame?: unknown; error?: string }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          resolve(result);
        };

        socket.on('message', (data: Buffer) => finish({ frame: JSON.parse(data.toString()) }));
        socket.on('error', (error: Error) => finish({ error: error.message }));
        socket.on('close', () => finish({ error: 'closed without a frame' }));
      });
    }

    let listening: FastifyInstance;
    let base: string;

    beforeEach(async () => {
      listening = buildServer({
        service, repositories, metrics: service.metrics,
        health: new HealthMonitor(), authToken: TOKEN,
      });
      const address = await listening.listen({ port: 0, host: '127.0.0.1' });
      base = address.replace('http://', 'ws://');
    });

    afterEach(async () => {
      await listening.close();
    });

    it('streams status to an authenticated socket', async () => {
      const { frame } = await connect(`${base}/ws?token=${encodeURIComponent(TOKEN)}`);
      expect(frame).toMatchObject({ type: 'status' });
    });

    it('refuses the upgrade for an unauthenticated client', async () => {
      // This socket streams live equity and positions; leaving it open was the
      // widest read hole, because it needed no polling to watch an account.
      const result = await connect(`${base}/ws`);
      expect(result.frame).toBeUndefined();
      expect(result.error).toMatch(/401/);
    });

    it('refuses the upgrade for a wrong token', async () => {
      const result = await connect(`${base}/ws?token=wrong-token-same-length-x`);
      expect(result.frame).toBeUndefined();
      expect(result.error).toMatch(/401/);
    });
  });

  // ---- broker session ----------------------------------------------------

  describe('POST /api/broker/session', () => {
    function withSessionHandler(
      handler: (input: { requestToken?: string; accessToken?: string; actor: string }) =>
        Promise<{ expiresAt: number | null }>,
    ): FastifyInstance {
      return buildServer({
        service, repositories, metrics: service.metrics,
        health: new HealthMonitor(), authToken: TOKEN,
        onBrokerSession: handler,
      });
    }

    it('rejects an unauthenticated attempt to set the broker token', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/broker/session', payload: { requestToken: 'x' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s when the configured broker has no session', async () => {
      // The paper broker has nothing to refresh; saying so beats a 500.
      const response = await app.inject({
        method: 'POST', url: '/api/broker/session', headers: auth,
        payload: { requestToken: 'x' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('passes a request token through and reports the expiry', async () => {
      const seen: unknown[] = [];
      const server = withSessionHandler(async (input) => {
        seen.push(input);
        return { expiresAt: 1_700_000_000_000 };
      });
      await server.ready();

      try {
        const response = await server.inject({
          method: 'POST', url: '/api/broker/session', headers: auth,
          payload: { requestToken: 'req-123', actor: 'alice' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().expiresAt).toBe(1_700_000_000_000);
        expect(seen).toEqual([{ requestToken: 'req-123', actor: 'alice' }]);
      } finally {
        await server.close();
      }
    });

    it('accepts an access token obtained elsewhere', async () => {
      const seen: unknown[] = [];
      const server = withSessionHandler(async (input) => {
        seen.push(input);
        return { expiresAt: null };
      });
      await server.ready();

      try {
        const response = await server.inject({
          method: 'POST', url: '/api/broker/session', headers: auth,
          payload: { accessToken: 'tok-456' },
        });

        expect(response.statusCode).toBe(200);
        expect(seen).toEqual([{ accessToken: 'tok-456', actor: 'api' }]);
      } finally {
        await server.close();
      }
    });

    it('requires one of the two tokens', async () => {
      const server = withSessionHandler(async () => ({ expiresAt: null }));
      await server.ready();

      try {
        const response = await server.inject({
          method: 'POST', url: '/api/broker/session', headers: auth, payload: {},
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await server.close();
      }
    });

    it('reports a rejected exchange as a broker failure, not a bad request', async () => {
      const server = withSessionHandler(async () => {
        throw new Error('token exchange failed: invalid request token');
      });
      await server.ready();

      try {
        const response = await server.inject({
          method: 'POST', url: '/api/broker/session', headers: auth,
          payload: { requestToken: 'stale' },
        });

        // 502: the operator should retry the login, not fix their payload.
        expect(response.statusCode).toBe(502);
        expect(response.json().error).toMatch(/invalid request token/);
      } finally {
        await server.close();
      }
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

      const candles = (await get('/api/candles/NSE:TEST')).json();
      expect(candles.candles).toHaveLength(2);

      const symbols = (await get('/api/symbols')).json();
      expect(symbols.symbols).toContain('NSE:TEST');
    });
  });

  // ---- health & metrics --------------------------------------------------

  describe('operational routes', () => {
    it('serves Prometheus metrics as text', async () => {
      const response = await get('/metrics');
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
      const body = (await get('/api/approvals')).json();
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
