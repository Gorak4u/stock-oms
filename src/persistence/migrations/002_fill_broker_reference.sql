-- Fills must be storable even when the order they belong to is not known.
--
-- `fill.order_id` carried a foreign key to `"order".id`, which is the
-- platform's own identifier. Every broker, however, reports fills against its
-- *own* order id: Kite returns `order_id` from its trade book, and the paper
-- broker returns `paper-N`. Neither is a row in `"order"`.
--
-- So the first fill of any live session failed the constraint. Reconciliation
-- adopting an unseen fill hit it too — the one path whose entire purpose is
-- handling fills for orders the platform has no record of.
--
-- That mattered more than a failed insert. Startup rebuilds the portfolio by
-- replaying stored fills, so a fill that cannot be stored is a position that
-- disappears on the next restart while still existing at the broker: the
-- platform trading against a position it does not know it has, which is the
-- exact failure the fill path was written to prevent.
--
-- The fix separates durability from attribution. A fill is money that moved and
-- must always be recorded; naming which of our orders caused it is best-effort.
--
--   * The foreign key is dropped. `order_id` stays NOT NULL and stays the
--     dedupe key, holding the platform order id when it is known and the
--     broker's id when it is not — so the UNIQUE constraint that makes
--     replaying a fill a no-op keeps working unchanged.
--   * `broker_order_id` records the broker's own reference either way, so a
--     fill can always be traced back to the venue.

ALTER TABLE trading.fill DROP CONSTRAINT IF EXISTS fill_order_id_fkey;

ALTER TABLE trading.fill ADD COLUMN IF NOT EXISTS broker_order_id TEXT;

-- Reconciliation looks fills up by the broker's reference when matching the
-- platform's view against the venue's.
CREATE INDEX IF NOT EXISTS fill_broker_order_idx ON trading.fill (broker_order_id)
  WHERE broker_order_id IS NOT NULL;

-- Resolving a broker order id to the platform's order is now on the hot path
-- for every incoming fill.
CREATE INDEX IF NOT EXISTS order_broker_order_idx ON trading."order" (broker_order_id)
  WHERE broker_order_id IS NOT NULL;
