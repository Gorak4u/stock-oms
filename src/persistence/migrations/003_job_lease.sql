-- Leases for scheduled work that cannot hold a connection.
--
-- The advisory lock in leaderLock.ts is held by a connection and released the
-- instant that connection dies, which is exactly right for a long-lived
-- process. A serverless invocation has no long-lived connection, so the lock
-- would be taken and dropped on every tick, guarding nothing.
--
-- This expresses the same guarantee as a row with an expiry: taken atomically,
-- renewable while work is in progress, and reclaimable once the holder's lease
-- lapses. One row per named job so ingestion and trading do not block each
-- other.

CREATE TABLE IF NOT EXISTS trading.job_lease (
  name          TEXT PRIMARY KEY,
  -- Identifies the invocation holding it, so release and renew cannot act on
  -- someone else's lease.
  owner         TEXT NOT NULL,
  acquired_at   BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);
