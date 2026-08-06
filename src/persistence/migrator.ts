/**
 * Forward-only schema migrations.
 *
 * Replaces re-running one `schema.sql` on every boot. That worked while every
 * statement was `CREATE ... IF NOT EXISTS`, but it has no answer to the first
 * change that is not a create — altering a column, backfilling a value,
 * dropping an index. This runner gives that change somewhere to live.
 *
 * Three properties are what make it safe to run automatically at startup:
 *
 * - **Each migration is one transaction.** A statement that fails rolls its
 *   whole migration back, so the schema is never left half-applied. Postgres
 *   has transactional DDL; this takes advantage of it.
 * - **An advisory lock serialises appliers.** Two containers starting together
 *   would otherwise race to apply the same migration, and `CREATE TABLE` is not
 *   idempotent under concurrency. The second waits, then finds nothing to do.
 * - **Applied migrations are checksummed.** Editing a file that has already run
 *   is the quiet way to make production and a fresh database disagree forever;
 *   it is refused rather than ignored.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * Arbitrary but fixed: the key two processes contend on to apply migrations.
 * Kept below 2^31 for the same reason as the leader lock — Postgres splits a
 * larger advisory key across `classid` and `objid` in `pg_locks`.
 */
const ADVISORY_LOCK_KEY = 1_954_723_901;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export class MigrationDriftError extends Error {
  constructor(readonly version: string) {
    super(
      `migration ${version} has already been applied but its file has changed. ` +
        'Applied migrations are immutable — add a new migration instead of editing this one.',
    );
    this.name = 'MigrationDriftError';
  }
}

function checksum(sql: string): string {
  // Normalise line endings so a file checked out on Windows does not read as
  // drift against the same file applied from Linux.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** Default location, resolved relative to this module so it works from `dist`. */
export function defaultMigrationsDir(): string {
  return join(__dirname, 'migrations');
}

/**
 * Loads migrations from disk, ordered by version.
 *
 * Files are named `<version>_<name>.sql`, e.g. `001_initial.sql`. Versions are
 * compared as strings, which is why they are zero-padded — `10` must not sort
 * before `2`.
 */
export function loadMigrations(dir = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations = files.map((file): Migration => {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`migration filename ${file} must look like 001_description.sql`);
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version: match[1]!,
      name: match[2]!,
      sql,
      checksum: checksum(sql),
    };
  });

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    seen.add(migration.version);
  }

  return migrations;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export class Migrator {
  constructor(
    private readonly pool: Pool,
    private readonly dir: string = defaultMigrationsDir(),
  ) {}

  /**
   * Creates the ledger. Must be called with the advisory lock held.
   *
   * `CREATE TABLE IF NOT EXISTS` is *not* safe under concurrency: two sessions
   * can both pass the existence check and then race, and the loser gets a
   * duplicate-key violation on `pg_type` rather than the silent no-op the
   * syntax suggests. So the ledger is created inside the same lock that
   * serialises the migrations themselves — it cannot bootstrap itself outside
   * the mechanism that makes it safe.
   */
  private static async ensureLedger(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS trading;
      CREATE TABLE IF NOT EXISTS trading.schema_migration (
        version     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  BIGINT NOT NULL
      );
    `);
  }

  /** Runs `fn` with the migration advisory lock held. */
  private async withLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      // Session-level lock: held until explicitly released, so it spans the
      // several transactions below rather than just the next one.
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      await Migrator.ensureLedger(client);
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  async applied(): Promise<AppliedMigration[]> {
    return this.withLock(async (client) => {
      const { rows } = await client.query<{
        version: string; name: string; checksum: string; applied_at: string;
      }>('SELECT version, name, checksum, applied_at FROM trading.schema_migration ORDER BY version');

      return rows.map((row) => ({
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: Number(row.applied_at),
      }));
    });
  }

  /**
   * Applies every migration not yet recorded, in version order.
   *
   * Safe to call on every boot and from several processes at once.
   */
  async migrate(): Promise<MigrateResult> {
    return this.withLock(async (client) => {
      const { rows } = await client.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM trading.schema_migration',
      );
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));

      const migrations = loadMigrations(this.dir);
      const freshlyApplied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const migration of migrations) {
        const previousChecksum = applied.get(migration.version);

        if (previousChecksum !== undefined) {
          if (previousChecksum !== migration.checksum) {
            throw new MigrationDriftError(migration.version);
          }
          alreadyApplied.push(migration.version);
          continue;
        }

        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO trading.schema_migration (version, name, checksum, applied_at)
             VALUES ($1, $2, $3, $4)`,
            [migration.version, migration.name, migration.checksum, Date.now()],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `migration ${migration.version}_${migration.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }

        freshlyApplied.push(migration.version);
      }

      return { applied: freshlyApplied, alreadyApplied };
    });
  }
}
