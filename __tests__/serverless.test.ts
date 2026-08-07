/**
 * Serverless composition tests.
 *
 * The claim being checked is narrow and important: an application rebuilt from
 * the database on every invocation behaves like the one that stayed up. That is
 * only true because the pipeline's risk state and the runner's square-off guard
 * are persisted — before they were, a serverless deployment would have reset
 * the drawdown baseline on every tick and left the kill switches permanently
 * inert while every dashboard showed green.
 *
 * The lease tests matter for the same reason the leader lock does: two
 * overlapping invocations that both decide are two orders for one intent.
 */

import { Pool } from 'pg';
import { Database } from '../src/persistence/postgres';
import { TickLease } from '../src/persistence/tickLease';
import { announceUnavailable, postgresReachable } from './support/infra';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading';

const POSTGRES_AVAILABLE = postgresReachable(DATABASE_URL);
if (!POSTGRES_AVAILABLE) {
  announceUnavailable('Postgres', DATABASE_URL, 'the serverless suite');
}

(POSTGRES_AVAILABLE ? describe : describe.skip)('TickLease', () => {
  let pool: Pool;
  let database: Database;

  beforeAll(async () => {
    database = new Database(DATABASE_URL);
    await database.migrate();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await pool.query('DELETE FROM trading.job_lease');
  });

  afterEach(async () => {
    await pool.end();
  });

  it('grants the lease to the first caller', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    expect(await lease.acquire('worker-a')).not.toBeNull();
  });

  it('refuses a second holder while the first lease is live', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    await lease.acquire('worker-a');

    // Two overlapping cron deliveries must not both decide.
    expect(await lease.acquire('worker-b')).toBeNull();
  });

  it('decides atomically under genuine concurrency', async () => {
    // A read-then-write implementation would let both callers through here.
    const lease = new TickLease(pool, { name: 'test' });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => lease.acquire(`worker-${i}`)),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('hands the lease on once it expires', async () => {
    let now = 1_000_000;
    const lease = new TickLease(pool, { name: 'test', ttlMs: 1000, clock: () => now });

    await lease.acquire('worker-a');
    expect(await lease.acquire('worker-b')).toBeNull();

    // An invocation that died holds nothing once its lease lapses.
    now += 1001;
    expect(await lease.acquire('worker-b')).not.toBeNull();
  });

  it('releases so the next tick need not wait out the ttl', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    await lease.acquire('worker-a');
    await lease.release('worker-a');

    expect(await lease.acquire('worker-b')).not.toBeNull();
  });

  it('ignores a release from someone who does not hold it', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    await lease.acquire('worker-a');

    await lease.release('worker-b');

    // worker-a still holds it; a stray release must not free someone else's.
    expect(await lease.acquire('worker-c')).toBeNull();
  });

  it('renews only for the current holder', async () => {
    let now = 1_000_000;
    const lease = new TickLease(pool, { name: 'test', ttlMs: 1000, clock: () => now });
    await lease.acquire('worker-a');

    now += 500;
    expect(await lease.renew('worker-a')).toBe(true);
    expect(await lease.renew('worker-b')).toBe(false);

    // The renewal moved the expiry, so the original ttl has now passed without
    // the lease lapsing.
    now += 700;
    expect(await lease.acquire('worker-b')).toBeNull();
  });

  it('releases the lease even when the work throws', async () => {
    const lease = new TickLease(pool, { name: 'test' });

    await expect(
      lease.withLease('worker-a', async () => {
        throw new Error('tick blew up');
      }),
    ).rejects.toThrow('tick blew up');

    // A failed tick must not wedge the schedule until the ttl expires.
    expect(await lease.acquire('worker-b')).not.toBeNull();
  });

  it('returns null from withLease rather than running when the lease is held', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    await lease.acquire('worker-a');

    let ran = false;
    const result = await lease.withLease('worker-b', async () => {
      ran = true;
      return 'done';
    });

    expect(result).toBeNull();
    expect(ran).toBe(false);
  });

  it('keeps separate leases for separate jobs', async () => {
    const trading = new TickLease(pool, { name: 'trading' });
    const ingestion = new TickLease(pool, { name: 'ingestion' });

    await trading.acquire('worker-a');
    // Ingestion must not be blocked behind trading.
    expect(await ingestion.acquire('worker-a')).not.toBeNull();
  });

  it('reports the current holder for the health endpoint', async () => {
    const lease = new TickLease(pool, { name: 'test' });
    expect(await lease.current()).toBeNull();

    await lease.acquire('worker-a');
    expect((await lease.current())?.owner).toBe('worker-a');
  });
});
