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
