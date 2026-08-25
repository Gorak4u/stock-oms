-- Closes the remaining write path into the append-only audit log.
--
-- 001 installed a row-level trigger on UPDATE and DELETE, which is what the
-- application could plausibly do by mistake. It does not cover TRUNCATE:
-- Postgres never fires a FOR EACH ROW trigger for it, because it removes rows
-- without visiting them. So `TRUNCATE trading.audit_record` succeeded against a
-- database whose whole point was that history cannot be rewritten — and it is
-- the most destructive of the three, taking the entire hash chain in one
-- statement rather than one record.
--
-- TRUNCATE also reaches the table indirectly: 001 declares foreign keys with
-- ON DELETE CASCADE elsewhere in the schema, and a TRUNCATE ... CASCADE from a
-- test fixture or a cleanup script propagates. A statement-level trigger fires
-- for both the direct and the cascaded case.
--
-- The chain remains verifiable end to end only if no row ever leaves it, so the
-- correct answer to all three verbs is the same: refuse. Dropping the table is
-- still possible for a superuser, which is a different threat and belongs to
-- database roles rather than to a trigger.

DROP TRIGGER IF EXISTS audit_no_truncate ON trading.audit_record;
CREATE TRIGGER audit_no_truncate
  BEFORE TRUNCATE ON trading.audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION trading.audit_is_append_only();
