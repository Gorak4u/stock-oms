/**
 * Single-writer guard for serverless ticks.
 *
 * The advisory lock in `leaderLock.ts` is the right primitive for a long-lived
 * process: it is held by a connection and released the instant that connection
 * dies. Under serverless there is no long-lived connection — each invocation
 * gets its own and drops it — so the lock would be taken and released on every
 * tick, guarding nothing.
 *
 * This is the same guarantee expressed as a row: a lease with an expiry, taken
 * atomically, extended while work is in progress, and released at the end. Two
 * overlapping invocations cannot both hold it, and a lease held by an
 * invocation that died is reclaimed once it expires.
 *
 * It is strictly weaker than the advisory lock and that is worth stating
 * plainly. The lock's guarantee comes from the database noticing a dead
 * connection; the lease's comes from a clock. If an invocation stalls past its
 * lease without dying — a paused container, a long GC — a second one can begin
 * while the first is still able to act. The window is bounded by the lease
 * duration, which is why it is set well beyond the time a tick should ever
 * take, and why order submission carries idempotency keys underneath it.
 */

import type { Pool } from 'pg';
import type { Timestamp } from '../domain/types';

/** One lease per named job, so ingestion and trading do not block each other. */
export interface LeaseOptions {
  readonly name?: string;
  /** How long a taken lease stays valid without renewal. */
  readonly ttlMs?: number;
  readonly clock?: () => Timestamp;
}

export interface LeaseHandle {
  readonly owner: string;
  readonly expiresAt: Timestamp;
}

export class TickLease {
  private readonly name: string;
  private readonly ttlMs: number;
  private readonly clock: () => Timestamp;

  constructor(
    private readonly pool: Pool,
    options: LeaseOptions = {},
  ) {
    this.name = options.name ?? 'trading-tick';
    // Generous relative to a tick, so an ordinary slow broker call does not let
    // a second invocation in; short enough that a dead invocation does not
    // block trading for long.
    this.ttlMs = options.ttlMs ?? 120_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Takes the lease, or returns null if someone else holds an unexpired one.
   *
   * The whole decision happens in one statement. Reading first and writing
   * second would leave a window in which two invocations both saw the lease
   * free — which, on a trading path, means two orders for one intent.
   */
  async acquire(owner: string): Promise<LeaseHandle | null> {
    const now = this.clock();
    const expiresAt = now + this.ttlMs;

    const { rows } = await this.pool.query<{ owner: string; expires_at: string }>(
      `INSERT INTO trading.job_lease (name, owner, acquired_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
         SET owner = EXCLUDED.owner,
             acquired_at = EXCLUDED.acquired_at,
             expires_at = EXCLUDED.expires_at
         WHERE trading.job_lease.expires_at <= $3
       RETURNING owner, expires_at`,
      [this.name, owner, now, expiresAt],
    );

    const row = rows[0];
    // No row means the WHERE blocked the update: a live lease is held.
    if (!row || row.owner !== owner) return null;

    return { owner, expiresAt: Number(row.expires_at) };
  }

  /**
   * Extends a lease this owner still holds.
   *
   * For work that legitimately runs long. Returns false if the lease was lost,
   * which the caller must treat as a signal to stop — continuing would be
   * acting outside the guarantee.
   */
  async renew(owner: string): Promise<boolean> {
    const now = this.clock();
    const { rowCount } = await this.pool.query(
      `UPDATE trading.job_lease
          SET expires_at = $3
        WHERE name = $1 AND owner = $2 AND expires_at > $4`,
      [this.name, owner, now + this.ttlMs, now],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Releases the lease, if this owner still holds it.
   *
   * Expiring it rather than deleting the row keeps the history of who ran last,
   * which is the first thing worth knowing when a tick misbehaves.
   */
  async release(owner: string): Promise<void> {
    await this.pool.query(
      `UPDATE trading.job_lease SET expires_at = $3
        WHERE name = $1 AND owner = $2`,
      [this.name, owner, this.clock()],
    );
  }

  /** Who holds it and until when, for the health endpoint. */
  async current(): Promise<{ owner: string; expiresAt: Timestamp } | null> {
    const { rows } = await this.pool.query<{ owner: string; expires_at: string }>(
      'SELECT owner, expires_at FROM trading.job_lease WHERE name = $1', [this.name],
    );
    const row = rows[0];
    return row ? { owner: row.owner, expiresAt: Number(row.expires_at) } : null;
  }

  /** Runs `fn` under the lease, releasing it however that ends. */
  async withLease<T>(owner: string, fn: () => Promise<T>): Promise<T | null> {
    const handle = await this.acquire(owner);
    if (!handle) return null;

    try {
      return await fn();
    } finally {
      await this.release(owner).catch(() => undefined);
    }
  }
}
