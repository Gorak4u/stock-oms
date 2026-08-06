/**
 * Single-writer guard for the trading loop.
 *
 * Two instances of this process running at once is not a scaling story, it is
 * a duplicate-position story: both would read the same bars, reach the same
 * decision, and send two orders. The OMS's idempotency keys do not save you,
 * because each instance derives its own key from its own decision — they are
 * different intents that happen to be identical.
 *
 * A Postgres session-level advisory lock is the right primitive here because
 * the database is already a hard dependency and the lock dies with the
 * connection. A crashed leader releases it when its socket closes; there is no
 * lease to expire, no clock to trust, and nothing to clean up by hand.
 *
 * The API still serves on a follower — reads, health and metrics all work.
 * Only the loop that can place orders is gated.
 */

import type { Pool, PoolClient } from 'pg';

/**
 * Distinct from the migration lock; the two must never contend.
 *
 * Deliberately below 2^31. `pg_advisory_lock(bigint)` stores its key in
 * `pg_locks` split across two 32-bit columns — `classid` takes the high half
 * and `objid` the low half — so a larger key would land with a non-zero
 * `classid` and the heartbeat below, which matches on `objid`, would never find
 * it. The lock would be genuinely held while the holder believed it had lost
 * it, stood down, and let a second instance take over: two leaders, which is
 * the exact thing this file exists to prevent.
 */
const TRADING_LEADER_KEY = 1_954_723_902;

export interface LeaderLockOptions {
  /** How often to verify the connection still holds the lock. */
  readonly heartbeatMs?: number;
  /** Called when leadership is lost while running — the loop must stop. */
  readonly onLost?: (reason: string) => void;
  /**
   * How often a follower re-contends for the lock.
   *
   * Without this, every rolling deploy would end with a process that never
   * trades: the new instance starts while the old still holds the lock, comes
   * up read-only, and — with a single attempt at startup — stays read-only
   * forever even after the old one exits. Set to 0 to disable retrying.
   */
  readonly retryIntervalMs?: number;
  /** Called when leadership is taken, including on a later retry. */
  readonly onAcquired?: () => void;
}

export class LeaderLock {
  private client: PoolClient | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private held = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: LeaderLockOptions = {},
  ) {}

  get isLeader(): boolean {
    return this.held;
  }

  /**
   * Tries once to take leadership, without blocking.
   *
   * Non-blocking on purpose: a follower should come up, serve reads and say so,
   * rather than hang at startup with no explanation. When it fails, a retry
   * timer starts so the follower is promoted as soon as the incumbent leaves —
   * which is what makes a rolling deploy work.
   */
  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    if (this.stopped) return false;

    const client = await this.pool.connect();

    let locked = false;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [TRADING_LEADER_KEY],
      );
      locked = rows[0]?.locked === true;
    } catch (error) {
      client.release();
      throw error;
    }

    if (!locked) {
      client.release();
      this.startRetry();
      return false;
    }

    // Held for the lifetime of this client, so it is never returned to the
    // pool — releasing it would hand the lock-holding session to someone
    // else, and the lock with it.
    this.client = client;
    this.held = true;
    this.stopRetry();
    this.startHeartbeat();
    this.options.onAcquired?.();
    return true;
  }

  /**
   * Polls for the lock while a follower.
   *
   * Deliberately quiet: a follower waiting for the incumbent to finish a deploy
   * is the normal case, not an incident, so promotion is announced through
   * `onAcquired` and failures to promote are not announced at all.
   */
  private startRetry(): void {
    const interval = this.options.retryIntervalMs ?? 15_000;
    if (interval <= 0 || this.retry || this.stopped) return;

    this.retry = setInterval(() => {
      void this.tryAcquire().catch(() => undefined);
    }, interval);

    // Never keep the process alive for a retry alone.
    this.retry.unref?.();
  }

  private stopRetry(): void {
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
  }

  /**
   * Watches the lock-holding connection.
   *
   * A dropped connection releases the advisory lock server-side, which means
   * another instance can take it. This process must notice and stop trading —
   * otherwise the guarantee inverts and there are briefly two leaders.
   */
  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 10_000;

    this.heartbeat = setInterval(() => {
      void (async () => {
        if (!this.client) return;
        try {
          const { rows } = await this.client.query<{ held: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
               WHERE locktype = 'advisory'
                 AND classid = 0
                 AND objid = $1
                 AND objsubid = 1
                 AND pid = pg_backend_pid()
                 AND granted
             ) AS held`,
            [TRADING_LEADER_KEY],
          );

          if (!rows[0]?.held) {
            this.lose('the advisory lock is no longer held by this session');
          }
        } catch (error) {
          this.lose(error instanceof Error ? error.message : String(error));
        }
      })();
    }, interval);

    // Never keep the process alive for a heartbeat alone.
    this.heartbeat.unref?.();
  }

  private lose(reason: string): void {
    if (!this.held) return;
    this.held = false;
    this.stopHeartbeat();

    // Destroy rather than release: the session is in an unknown state, and
    // returning it to the pool would hand out a connection that may still be
    // mid-failure.
    this.client?.release(true);
    this.client = null;

    this.options.onLost?.(reason);

    // Contend again. Losing the lock is usually a dropped connection rather
    // than a second instance genuinely taking over, so the same process is
    // often the right leader once the database is reachable again.
    this.startRetry();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Releases leadership and stops contending. Safe to call when not held.
   *
   * Terminal: this is shutdown, so a follower must not quietly promote itself
   * on a retry timer while the process is on its way out.
   */
  async release(): Promise<void> {
    this.stopped = true;
    this.stopHeartbeat();
    this.stopRetry();

    if (!this.client) {
      this.held = false;
      return;
    }

    const client = this.client;
    this.client = null;
    this.held = false;

    try {
      await client.query('SELECT pg_advisory_unlock($1)', [TRADING_LEADER_KEY]);
      client.release();
    } catch {
      // Could not unlock cleanly — drop the connection instead. The lock is
      // released by the server when the session ends either way.
      client.release(true);
    }
  }
}
