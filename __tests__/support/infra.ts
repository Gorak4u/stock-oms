/**
 * Test-infrastructure gating.
 *
 * Several suites need a real Postgres or Redis. Locally, skipping them when
 * there is none is the right call — a unit test run should not require docker
 * compose. In CI it is the wrong call entirely: the adapter suites are the only
 * thing standing between a broken query and production, and a green build that
 * silently ran none of them is worse than a red one.
 *
 * `REQUIRE_INFRA=1` turns a skip into a failure. CI sets it; developers do not.
 */

import { execFileSync } from 'node:child_process';

export const REQUIRE_INFRA = process.env.REQUIRE_INFRA === '1';

export function postgresReachable(url: string): boolean {
  try {
    const parsed = new URL(url);
    execFileSync(
      'pg_isready',
      ['-h', parsed.hostname, '-p', parsed.port || '5432', '-t', '2'],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

export function redisReachable(url: string): boolean {
  try {
    const parsed = new URL(url);
    execFileSync(
      'redis-cli',
      ['-h', parsed.hostname, '-p', parsed.port || '6379', 'ping'],
      { stdio: 'ignore', timeout: 2000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Announces an unavailable dependency, and fails the run when infra is required.
 *
 * Throwing at module scope aborts the suite that called it, which is what makes
 * this visible: a skipped adapter suite should never be able to look like a
 * passing one.
 */
export function announceUnavailable(dependency: string, url: string, suite: string): void {
  const message =
    `${dependency} not reachable at ${url} — ${suite} would be SKIPPED.`;

  if (REQUIRE_INFRA) {
    throw new Error(
      `${message} REQUIRE_INFRA=1 is set, so this is a failure rather than a skip.`,
    );
  }

  console.warn(`${message} Start it, or set the connection URL, to run these tests.`);
}

/**
 * Resets every table a suite writes to, between cases.
 *
 * `audit_record` needs saying out loud. Migration 004 forbids TRUNCATE on it,
 * so the whole statement — every table in the list — is refused unless the
 * guard is lifted first. That is the guard working: wiping a hash-chained
 * append-only log is exactly the thing it exists to stop, and a test fixture is
 * not an exception to the rule so much as the one caller with a legitimate
 * reason to ask for one. So it asks explicitly, here, in a helper named for
 * what it does, rather than the trigger being weakened to make room for it.
 *
 * Wrapped in a transaction so the guard cannot be left off: DDL is
 * transactional in Postgres, so a throw between the disable and the re-enable
 * rolls both back along with the truncation.
 */
export async function resetSchema(pool: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await pool.query(`
    BEGIN;
    ALTER TABLE trading.audit_record DISABLE TRIGGER audit_no_truncate;
    TRUNCATE trading.fill, trading."order", trading.closed_trade, trading.position,
             trading.equity_point, trading.audit_record, trading.candle,
             trading.model, trading.runtime_state, trading.reconciliation_break
      RESTART IDENTITY CASCADE;
    ALTER TABLE trading.audit_record ENABLE TRIGGER audit_no_truncate;
    COMMIT;`);
}
