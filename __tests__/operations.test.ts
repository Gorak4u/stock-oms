/**
 * Operational-machinery tests.
 *
 * Migrations, leader election, session lifecycle, shutdown drain and durable
 * alert delivery. None of this is trading logic, which is exactly why it needs
 * tests: it is the code that runs once at startup or once during an incident,
 * where a bug is discovered at the worst possible moment.
 *
 * The Postgres-backed suites run against a real database and skip loudly when
 * there is none, on the same terms as the persistence suite.
 */

import Redis from 'ioredis';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

import { Migrator, MigrationDriftError, loadMigrations } from '../src/persistence/migrator';
import { LeaderLock } from '../src/persistence/leaderLock';
import { Database, databaseOptionsFromEnv } from '../src/persistence/postgres';
import { KiteSession, nextTokenExpiry } from '../src/execution/kiteSession';
import { ZerodhaBroker } from '../src/execution/zerodhaBroker';
import { AlertDelivery } from '../src/monitoring/alertDelivery';
import { LiveRunner } from '../src/runtime/runner';
import { TradingService } from '../src/runtime/tradingService';
import { PaperBroker } from '../src/execution/paperBroker';
import { ZERO_COST_SCHEDULE } from '../src/execution/costs';
import { memoryRepositories } from '../src/persistence/memory';
import { MarketCalendar } from '../src/marketdata/calendar';
import { AlertManager, MetricsRegistry, type Alert } from '../src/monitoring/metrics';
import { fromRupees } from '../src/domain/money';
import { announceUnavailable, postgresReachable, redisReachable } from './support/infra';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const POSTGRES_AVAILABLE = postgresReachable(DATABASE_URL);
const REDIS_AVAILABLE = redisReachable(REDIS_URL);

if (!POSTGRES_AVAILABLE) {
  announceUnavailable('Postgres', DATABASE_URL, 'the migration and leader-election suites');
}
if (!REDIS_AVAILABLE) {
  announceUnavailable('Redis', REDIS_URL, 'the alert-delivery suite');
}

// ===========================================================================
// Migrations
// ===========================================================================

describe('loadMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('orders by zero-padded version, not lexically by number', () => {
    writeFileSync(join(dir, '002_second.sql'), 'SELECT 2;');
    writeFileSync(join(dir, '010_tenth.sql'), 'SELECT 10;');
    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;');

    expect(loadMigrations(dir).map((m) => m.version)).toEqual(['001', '002', '010']);
  });

  it('rejects a filename that carries no version', () => {
    writeFileSync(join(dir, 'oops.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/001_description\.sql/);
  });

  it('rejects two migrations claiming the same version', () => {
    writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '001_b.sql'), 'SELECT 2;');
    expect(() => loadMigrations(dir)).toThrow(/duplicate migration version/);
  });

  it('ignores non-SQL files', () => {
    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'README.md'), 'notes');
    expect(loadMigrations(dir)).toHaveLength(1);
  });

  it('checksums content so an edit is detectable', () => {
    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;');
    const before = loadMigrations(dir)[0]!.checksum;

    writeFileSync(join(dir, '001_first.sql'), 'SELECT 2;');
    expect(loadMigrations(dir)[0]!.checksum).not.toBe(before);
  });

  it('treats CRLF and LF as the same content', () => {
    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;\nSELECT 2;');
    const lf = loadMigrations(dir)[0]!.checksum;

    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;\r\nSELECT 2;');
    expect(loadMigrations(dir)[0]!.checksum).toBe(lf);
  });
});

(POSTGRES_AVAILABLE ? describe : describe.skip)('Migrator against Postgres', () => {
  let pool: Pool;
  let dir: string;

  beforeEach(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    dir = mkdtempSync(join(tmpdir(), 'migrations-pg-'));
    await pool.query('DROP SCHEMA IF EXISTS migtest CASCADE');
    await pool.query('DROP TABLE IF EXISTS trading.schema_migration');
  });

  afterEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS migtest CASCADE');
    await pool.query('DROP TABLE IF EXISTS trading.schema_migration');
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies pending migrations and records them', async () => {
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest;');
    writeFileSync(join(dir, '002_table.sql'), 'CREATE TABLE migtest.t (id INT);');

    const result = await new Migrator(pool, dir).migrate();

    expect(result.applied).toEqual(['001', '002']);
    const { rows } = await pool.query('SELECT to_regclass($1) AS t', ['migtest.t']);
    expect(rows[0]?.t).not.toBeNull();
  });

  it('is idempotent — a second run applies nothing', async () => {
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest;');

    const migrator = new Migrator(pool, dir);
    await migrator.migrate();
    const second = await migrator.migrate();

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['001']);
  });

  it('applies only what is new when a migration is added', async () => {
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest;');
    await new Migrator(pool, dir).migrate();

    writeFileSync(join(dir, '002_table.sql'), 'CREATE TABLE migtest.t (id INT);');
    expect((await new Migrator(pool, dir).migrate()).applied).toEqual(['002']);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest;');
    await new Migrator(pool, dir).migrate();

    // Editing an applied migration is the quiet way to make production and a
    // fresh database disagree forever.
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest; -- changed');
    await expect(new Migrator(pool, dir).migrate()).rejects.toThrow(MigrationDriftError);
  });

  it('rolls a failed migration back whole', async () => {
    writeFileSync(
      join(dir, '001_partial.sql'),
      'CREATE SCHEMA migtest; CREATE TABLE migtest.ok (id INT); CREATE TABLE nonexistent.bad (id INT);',
    );

    await expect(new Migrator(pool, dir).migrate()).rejects.toThrow(/001_partial failed/);

    // Postgres has transactional DDL, so the earlier statements must be gone.
    const { rows } = await pool.query('SELECT to_regclass($1) AS t', ['migtest.ok']);
    expect(rows[0]?.t).toBeNull();
  });

  it('does not record a migration that failed', async () => {
    writeFileSync(join(dir, '001_bad.sql'), 'CREATE TABLE nonexistent.bad (id INT);');
    await expect(new Migrator(pool, dir).migrate()).rejects.toThrow();

    expect(await new Migrator(pool, dir).applied()).toEqual([]);
  });

  it('serialises concurrent appliers behind the advisory lock', async () => {
    writeFileSync(join(dir, '001_schema.sql'), 'CREATE SCHEMA migtest;');
    writeFileSync(join(dir, '002_table.sql'), 'CREATE TABLE migtest.t (id INT);');

    // Two processes starting together is the ordinary case for a rolling
    // deploy, and CREATE TABLE is not idempotent under concurrency.
    const results = await Promise.all([
      new Migrator(pool, dir).migrate(),
      new Migrator(pool, dir).migrate(),
    ]);

    const appliedTotal = results.flatMap((r) => r.applied);
    expect(appliedTotal.sort()).toEqual(['001', '002']);
  });

  it('adopts an existing database created by applying the schema directly', async () => {
    // The pre-migrator deployment path: the schema was already applied, with no
    // ledger. The baseline migration is written in IF NOT EXISTS form precisely
    // so adoption is a no-op that records the baseline.
    writeFileSync(
      join(dir, '001_schema.sql'),
      'CREATE SCHEMA IF NOT EXISTS migtest; CREATE TABLE IF NOT EXISTS migtest.t (id INT);',
    );
    await pool.query('CREATE SCHEMA IF NOT EXISTS migtest; CREATE TABLE IF NOT EXISTS migtest.t (id INT);');

    const result = await new Migrator(pool, dir).migrate();
    expect(result.applied).toEqual(['001']);
  });
});

(POSTGRES_AVAILABLE ? describe : describe.skip)('the shipped migrations', () => {
  it('apply cleanly to an empty database and are internally consistent', async () => {
    const database = new Database(DATABASE_URL);
    try {
      const result = await database.migrate();
      expect([...result.applied, ...result.alreadyApplied]).toContain('001');

      // Applying twice must be a no-op, which is what makes it safe to run on
      // every boot.
      expect((await database.migrate()).applied).toEqual([]);
    } finally {
      await database.close();
    }
  });
});

describe('databaseOptionsFromEnv', () => {
  it('defaults to bounded timeouts rather than none', () => {
    const options = databaseOptionsFromEnv({});
    expect(options.statementTimeoutMs).toBeGreaterThan(0);
    expect(options.connectionTimeoutMs).toBeGreaterThan(0);
    expect(options.max).toBeGreaterThan(0);
  });

  it('reads overrides', () => {
    const options = databaseOptionsFromEnv({ PGPOOL_MAX: '25', PG_STATEMENT_TIMEOUT_MS: '9000' });
    expect(options.max).toBe(25);
    expect(options.statementTimeoutMs).toBe(9000);
  });

  it('rejects a non-numeric override instead of silently using the default', () => {
    expect(() => databaseOptionsFromEnv({ PGPOOL_MAX: 'lots' })).toThrow(/positive number/);
  });

  it('enables TLS when PGSSLMODE asks for it', () => {
    expect(databaseOptionsFromEnv({ PGSSLMODE: 'require' }).ssl).toEqual({ rejectUnauthorized: false });
    expect(databaseOptionsFromEnv({ PGSSLMODE: 'verify-full' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(databaseOptionsFromEnv({}).ssl).toBeUndefined();
  });
});

// ===========================================================================
// Leader election
// ===========================================================================

(POSTGRES_AVAILABLE ? describe : describe.skip)('LeaderLock', () => {
  let pool: Pool;

  beforeEach(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  });

  afterEach(async () => {
    await pool.end();
  });

  it('grants leadership to the first caller', async () => {
    const lock = new LeaderLock(pool);
    try {
      expect(await lock.tryAcquire()).toBe(true);
      expect(lock.isLeader).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('refuses a second holder while the first is live', async () => {
    const first = new LeaderLock(pool);
    const second = new LeaderLock(pool);

    try {
      expect(await first.tryAcquire()).toBe(true);
      // Non-blocking: a follower must come up and say so rather than hang.
      expect(await second.tryAcquire()).toBe(false);
      expect(second.isLeader).toBe(false);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('hands leadership on after a release', async () => {
    const first = new LeaderLock(pool);
    const second = new LeaderLock(pool);

    await first.tryAcquire();
    await first.release();

    try {
      expect(await second.tryAcquire()).toBe(true);
    } finally {
      await second.release();
    }
  });

  it('is idempotent when already held', async () => {
    const lock = new LeaderLock(pool);
    try {
      expect(await lock.tryAcquire()).toBe(true);
      expect(await lock.tryAcquire()).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('tolerates a release that was never acquired', async () => {
    await expect(new LeaderLock(pool).release()).resolves.toBeUndefined();
  });

  it('keeps leadership across heartbeats', async () => {
    // Regression: the advisory key was originally above 2^31, so Postgres split
    // it across classid/objid in pg_locks and the heartbeat's objid match never
    // found it. The leader concluded it had lost the lock, stood down, and a
    // second instance took over — two leaders, from the guard against them.
    const lost: string[] = [];
    const lock = new LeaderLock(pool, {
      heartbeatMs: 50,
      onLost: (reason) => lost.push(reason),
    });

    try {
      expect(await lock.tryAcquire()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(lost).toEqual([]);
      expect(lock.isLeader).toBe(true);

      // And still genuinely exclusive, not merely believed to be.
      const other = new LeaderLock(pool);
      expect(await other.tryAcquire()).toBe(false);
      await other.release();
    } finally {
      await lock.release();
    }
  });

  it('promotes a follower once the leader releases', async () => {
    // The rolling-deploy case: the new instance starts while the old still
    // holds the lock. With a single attempt at startup it would stay read-only
    // forever, so every deploy would end with a process that never trades.
    const incumbent = new LeaderLock(pool);
    const acquisitions: number[] = [];
    const challenger = new LeaderLock(pool, {
      retryIntervalMs: 50,
      onAcquired: () => acquisitions.push(Date.now()),
    });

    try {
      expect(await incumbent.tryAcquire()).toBe(true);
      expect(await challenger.tryAcquire()).toBe(false);
      expect(challenger.isLeader).toBe(false);

      await incumbent.release();

      // The retry timer, not another explicit call, is what promotes it.
      for (let i = 0; i < 40 && !challenger.isLeader; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(challenger.isLeader).toBe(true);
      expect(acquisitions).toHaveLength(1);
    } finally {
      await incumbent.release();
      await challenger.release();
    }
  });

  it('stops contending once released, so a shutting-down process cannot promote', async () => {
    const incumbent = new LeaderLock(pool);
    const leaving = new LeaderLock(pool, { retryIntervalMs: 50 });

    try {
      await incumbent.tryAcquire();
      expect(await leaving.tryAcquire()).toBe(false);

      // Shutdown, then the incumbent goes away.
      await leaving.release();
      await incumbent.release();

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(leaving.isLeader).toBe(false);
    } finally {
      await incumbent.release();
      await leaving.release();
    }
  });

  it('fires onAcquired for a leader that wins immediately', async () => {
    let acquired = 0;
    const lock = new LeaderLock(pool, { onAcquired: () => (acquired += 1) });
    try {
      await lock.tryAcquire();
      expect(acquired).toBe(1);
    } finally {
      await lock.release();
    }
  });

  it('does not contend when retrying is disabled', async () => {
    const incumbent = new LeaderLock(pool);
    const passive = new LeaderLock(pool, { retryIntervalMs: 0 });

    try {
      await incumbent.tryAcquire();
      expect(await passive.tryAcquire()).toBe(false);

      await incumbent.release();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(passive.isLeader).toBe(false);
    } finally {
      await incumbent.release();
      await passive.release();
    }
  });

  it('reports the lock as held under the key it actually took', async () => {
    const lock = new LeaderLock(pool);
    try {
      await lock.tryAcquire();

      // Asserts the classid/objid split directly, so a future key change that
      // reintroduces the bug fails here rather than in production.
      const { rows } = await pool.query<{ classid: number; objid: number; objsubid: number }>(
        `SELECT classid, objid, objsubid FROM pg_locks
         WHERE locktype = 'advisory' AND granted`,
      );
      expect(rows.some((r) => r.classid === 0 && r.objsubid === 1)).toBe(true);
    } finally {
      await lock.release();
    }
  });
});

// ===========================================================================
// Kite session
// ===========================================================================

describe('KiteSession', () => {
  const morning = Date.parse('2024-06-14T04:00:00Z'); // 09:30 IST

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  }

  describe('nextTokenExpiry', () => {
    it('is the coming 07:30 IST', () => {
      // 04:00 UTC is 09:30 IST, so the next expiry is tomorrow morning.
      const expiry = nextTokenExpiry(morning);
      expect(new Date(expiry).toISOString()).toBe('2024-06-15T02:00:00.000Z');
    });

    it('is today when the clock is before 07:30 IST', () => {
      const earlyIst = Date.parse('2024-06-14T01:00:00Z'); // 06:30 IST
      expect(new Date(nextTokenExpiry(earlyIst)).toISOString()).toBe('2024-06-14T02:00:00.000Z');
    });

    it('is computed in IST regardless of the host timezone', () => {
      // The bug this guards: a container running in UTC expiring the token
      // seventeen and a half hours late, i.e. mid-session.
      const expiry = nextTokenExpiry(morning);
      const ist = new Date(expiry + 5.5 * 3600_000);
      expect(ist.getUTCHours()).toBe(7);
      expect(ist.getUTCMinutes()).toBe(30);
    });
  });

  it('adopts an environment-supplied token on a cold start', async () => {
    const repositories = memoryRepositories();
    const session = new KiteSession({
      apiKey: 'key', state: repositories.state, clock: () => morning,
    });

    expect(await session.load('env-token')).toBe(true);
    expect(session.accessToken()).toBe('env-token');
  });

  it('reuses a persisted token across a restart', async () => {
    const repositories = memoryRepositories();
    const first = new KiteSession({ apiKey: 'key', state: repositories.state, clock: () => morning });
    await first.load('env-token');

    const second = new KiteSession({
      apiKey: 'key', state: repositories.state, clock: () => morning + 3600_000,
    });

    expect(await second.load()).toBe(true);
    expect(second.accessToken()).toBe('env-token');
  });

  it('discards a token that has passed the daily expiry', async () => {
    const repositories = memoryRepositories();
    const yesterday = new KiteSession({
      apiKey: 'key', state: repositories.state, clock: () => morning,
    });
    await yesterday.load('stale-token');

    // Next day, after 07:30 IST.
    const today = new KiteSession({
      apiKey: 'key', state: repositories.state, clock: () => morning + 24 * 3600_000,
    });

    expect(await today.load()).toBe(false);
    expect(today.isValid).toBe(false);
  });

  it('throws a message naming the login URL when there is no token', async () => {
    const session = new KiteSession({ apiKey: 'key', clock: () => morning });
    await session.load();
    expect(() => session.accessToken()).toThrow(/kite\.zerodha\.com/);
  });

  it('exchanges a request token', async () => {
    const repositories = memoryRepositories();
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ status: 'success', data: { access_token: 'fresh', user_id: 'AB1234' } }),
    ) as unknown as typeof fetch;

    const session = new KiteSession({
      apiKey: 'key', apiSecret: 'secret', state: repositories.state,
      fetchImpl, clock: () => morning,
    });

    const result = await session.exchangeRequestToken('req-token');

    expect(result.accessToken).toBe('fresh');
    expect(session.accessToken()).toBe('fresh');
    expect(await repositories.state.get('broker:kite:session')).toMatchObject({
      accessToken: 'fresh', userId: 'AB1234',
    });
  });

  it('sends the sha256 checksum Kite expects', async () => {
    let sentBody = '';
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = typeof init?.body === 'string' ? init.body : '';
      return jsonResponse({ status: 'success', data: { access_token: 'fresh' } });
    }) as unknown as typeof fetch;

    const session = new KiteSession({
      apiKey: 'key', apiSecret: 'secret', fetchImpl, clock: () => morning,
    });
    await session.exchangeRequestToken('req-token');

    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('keyreq-tokensecret').digest('hex');
    expect(sentBody).toContain(`checksum=${expected}`);
  });

  it('refuses to exchange without an API secret', async () => {
    const session = new KiteSession({ apiKey: 'key', clock: () => morning });
    await expect(session.exchangeRequestToken('req')).rejects.toThrow(/KITE_API_SECRET/);
  });

  it('surfaces a rejected exchange', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ status: 'error', message: 'invalid request token' }, 400),
    ) as unknown as typeof fetch;

    const session = new KiteSession({
      apiKey: 'key', apiSecret: 'secret', fetchImpl, clock: () => morning,
    });

    await expect(session.exchangeRequestToken('bad')).rejects.toThrow(/invalid request token/);
  });

  it('raises a critical alert when the token is invalidated', async () => {
    const received: Alert[] = [];
    const alerts = new AlertManager();
    alerts.addSink((alert) => void received.push(alert));

    const session = new KiteSession({ apiKey: 'key', alerts, clock: () => morning });
    await session.load('token');
    await session.invalidate('broker said TokenException');

    const critical = received.find((a) => a.severity === 'critical');
    expect(critical?.title).toMatch(/re-authentication required/i);
    expect(session.isValid).toBe(false);
  });

  it('alerts once, not on every rejected call', async () => {
    const received: Alert[] = [];
    const alerts = new AlertManager();
    alerts.addSink((alert) => void received.push(alert));

    const session = new KiteSession({ apiKey: 'key', alerts, clock: () => morning });
    await session.load('token');

    await session.invalidate('first');
    await session.invalidate('second');

    expect(received.filter((a) => a.severity === 'critical')).toHaveLength(1);
  });

  it('drives the broker, so a refreshed token needs no restart', async () => {
    const repositories = memoryRepositories();
    const session = new KiteSession({
      apiKey: 'key', state: repositories.state, clock: () => morning,
    });
    await session.load('first-token');

    const seen: string[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return jsonResponse({ status: 'success', data: { equity: { available: { live_balance: 1 } } } });
    }) as unknown as typeof fetch;

    const broker = new ZerodhaBroker({
      apiKey: 'key', accessToken: () => session.accessToken(), fetchImpl,
    });

    await broker.getAvailableCash();
    await session.adoptAccessToken('second-token');
    await broker.getAvailableCash();

    expect(seen[0]).toContain('first-token');
    expect(seen[1]).toContain('second-token');
  });

  it('notifies the session when the broker rejects the token', async () => {
    const rejections: string[] = [];
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        { status: 'error', message: 'token expired', error_type: 'TokenException' },
        403,
      ),
    ) as unknown as typeof fetch;

    const broker = new ZerodhaBroker({
      apiKey: 'key', accessToken: 'stale', fetchImpl,
      onTokenRejected: (message) => rejections.push(message),
    });

    await expect(broker.getAvailableCash()).rejects.toThrow();
    expect(rejections).toEqual(['token expired']);
  });
});

// ===========================================================================
// Shutdown drain
// ===========================================================================

describe('LiveRunner drain', () => {
  function buildRunner(onBar: () => Promise<void>) {
    const repositories = memoryRepositories();
    const service = new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
      symbols: ['NSE:TEST'],
    });

    // Stand in for the pipeline so the tick's duration is controllable.
    (service as unknown as { onBar: () => Promise<void> }).onBar = onBar;

    return { service, repositories };
  }

  it('returns immediately when nothing is in flight', async () => {
    const { service, repositories } = buildRunner(async () => undefined);
    await service.start();

    const runner = new LiveRunner({ service, candles: repositories.candles });
    expect(await runner.drain(1000)).toBe(true);
  });

  it('waits for a tick already running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    let finished = false;
    const { service, repositories } = buildRunner(async () => {
      await blocked;
      finished = true;
    });
    await service.start();

    await repositories.candles.upsertMany(
      Array.from({ length: 100 }, (_, i) => ({
        symbol: 'NSE:TEST', interval: '1m' as const,
        timestamp: Date.parse('2024-06-14T04:00:00Z') + i * 60_000,
        open: fromRupees(100), high: fromRupees(101),
        low: fromRupees(99), close: fromRupees(100), volume: 1000,
      })),
    );

    const runner = new LiveRunner({
      service, candles: repositories.candles,
      clock: () => Date.parse('2024-06-14T05:00:00Z'),
    });

    const tick = runner.tick();
    const draining = runner.drain(5000);

    expect(finished).toBe(false);
    release();

    expect(await draining).toBe(true);
    expect(finished).toBe(true);
    await tick;
  });

  it('gives up rather than blocking shutdown forever', async () => {
    const { service, repositories } = buildRunner(
      () => new Promise<void>(() => undefined),
    );
    await service.start();

    await repositories.candles.upsertMany(
      Array.from({ length: 100 }, (_, i) => ({
        symbol: 'NSE:TEST', interval: '1m' as const,
        timestamp: Date.parse('2024-06-14T04:00:00Z') + i * 60_000,
        open: fromRupees(100), high: fromRupees(101),
        low: fromRupees(99), close: fromRupees(100), volume: 1000,
      })),
    );

    const runner = new LiveRunner({
      service, candles: repositories.candles,
      clock: () => Date.parse('2024-06-14T05:00:00Z'),
    });

    void runner.tick();
    // A wedged broker call must not hold shutdown open indefinitely — being
    // SIGKILLed is strictly worse than exiting deliberately.
    expect(await runner.drain(150)).toBe(false);
  });

  it('stops scheduling once drained', async () => {
    const { service, repositories } = buildRunner(async () => undefined);
    await service.start();

    const runner = new LiveRunner({ service, candles: repositories.candles });
    runner.start();
    await runner.drain(1000);

    expect(runner.isRunning).toBe(false);
  });
});

describe('LiveRunner leadership gate', () => {
  it('does nothing while not the leader', async () => {
    const repositories = memoryRepositories();
    const service = new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
      openingCash: fromRupees(1_000_000),
      calendar: new MarketCalendar({ holidays: [] }),
      symbols: ['NSE:TEST'],
    });
    await service.start();

    let bars = 0;
    (service as unknown as { onBar: () => Promise<void> }).onBar = async () => {
      bars += 1;
    };

    await repositories.candles.upsertMany(
      Array.from({ length: 100 }, (_, i) => ({
        symbol: 'NSE:TEST', interval: '1m' as const,
        timestamp: Date.parse('2024-06-14T04:00:00Z') + i * 60_000,
        open: fromRupees(100), high: fromRupees(101),
        low: fromRupees(99), close: fromRupees(100), volume: 1000,
      })),
    );

    let leader = false;
    const runner = new LiveRunner({
      service, candles: repositories.candles,
      canTrade: () => leader,
      clock: () => Date.parse('2024-06-14T05:00:00Z'),
    });

    await runner.tick();
    expect(bars).toBe(0);

    leader = true;
    await runner.tick();
    expect(bars).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Durable alert delivery
// ===========================================================================

(REDIS_AVAILABLE ? describe : describe.skip)('AlertDelivery', () => {
  let redis: Redis;
  let delivery: AlertDelivery;

  const alert: Alert = {
    severity: 'critical', title: 'Kill switch engaged',
    detail: 'daily loss limit', at: 1_700_000_000_000,
  };

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    await redis.del(
      'queue:alerts:ready', 'queue:alerts:delayed',
      'queue:alerts:processing', 'queue:alerts:dead', 'queue:alerts:processing:claimed',
    );
  });

  afterEach(async () => {
    await delivery?.drain();
    redis.disconnect();
  });

  it('delivers an enqueued alert to the webhook', async () => {
    const posted: unknown[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      posted.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    delivery = new AlertDelivery({ redis, webhookUrl: 'https://example.invalid/hook', fetchImpl });

    await delivery.sink()(alert);
    expect(await delivery.pump()).toBe(1);
    expect(posted).toEqual([alert]);
  });

  it('retries a failed delivery rather than losing the alert', async () => {
    let attempts = 0;
    const fetchImpl = jest.fn(async () => {
      attempts += 1;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    delivery = new AlertDelivery({
      redis, webhookUrl: 'https://example.invalid/hook', fetchImpl, maxAttempts: 3,
    });

    await delivery.sink()(alert);
    await delivery.pump();

    expect(attempts).toBe(1);
    // Not lost — parked on the delayed set awaiting its backoff.
    const depth = await delivery.depth();
    expect(depth.delayed + depth.ready).toBe(1);
  });

  it('dead-letters an alert that never delivers', async () => {
    const fetchImpl = jest.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    delivery = new AlertDelivery({
      redis, webhookUrl: 'https://example.invalid/hook', fetchImpl,
      maxAttempts: 1,
    });

    await delivery.sink()(alert);
    await delivery.pump();

    // Dead-lettered rather than dropped: an alert that failed repeatedly is
    // something an operator needs to find, not something to forget.
    expect(await delivery.deadLetters()).toHaveLength(1);
  });

  it('publishes queue depth as a metric', async () => {
    const metrics = new MetricsRegistry();
    const fetchImpl = jest.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    delivery = new AlertDelivery({
      redis, webhookUrl: 'https://example.invalid/hook', fetchImpl, metrics,
    });

    await delivery.sink()(alert);
    await delivery.reportDepth();

    expect(metrics.render()).toContain('trading_queue_depth');
  });

  it('never lets an unreachable queue turn one alert into two errors', async () => {
    const broken = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      // Without this ioredis keeps a reconnect timer alive and the suite hangs
      // past its last assertion.
      retryStrategy: () => null,
    });
    broken.on('error', () => undefined);

    const failing = new AlertDelivery({ redis: broken, webhookUrl: 'https://example.invalid/hook' });
    await expect(failing.sink()(alert)).resolves.toBeUndefined();

    broken.disconnect();
  });
});
