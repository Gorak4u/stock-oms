-- Trading platform schema.
--
-- Design notes that matter:
--
-- * Money is BIGINT paise everywhere, never NUMERIC or FLOAT. The application
--   already refuses to do float arithmetic on money; storing it as a float
--   would reintroduce exactly the drift the paise representation exists to
--   prevent, and reconciliation breaks are expensive to chase.
--
-- * Timestamps are BIGINT epoch milliseconds, matching the domain's
--   `Timestamp`. TIMESTAMPTZ would be more idiomatic SQL, but the round trip
--   through a driver's date handling is a place where a millisecond can be
--   lost, and bar boundaries are exactly where that would hurt.
--
-- * The audit log is append-only and hash-chained. There is no UPDATE or
--   DELETE path for it in the application, and the trigger below enforces that
--   at the database level so a mistake in application code cannot rewrite
--   history.

CREATE SCHEMA IF NOT EXISTS trading;

SET search_path TO trading, public;

-- ---------------------------------------------------------------------------
-- Instruments and market data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instrument (
  symbol        TEXT PRIMARY KEY,
  exchange      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('EQUITY', 'FUTURE', 'OPTION', 'INDEX')),
  lot_size      INTEGER NOT NULL CHECK (lot_size >= 1),
  tick_size     BIGINT NOT NULL CHECK (tick_size > 0),
  expiry        TEXT,
  strike        BIGINT,
  right_type    TEXT CHECK (right_type IN ('CE', 'PE')),
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS candle (
  symbol        TEXT NOT NULL,
  interval      TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  open          BIGINT NOT NULL CHECK (open > 0),
  high          BIGINT NOT NULL CHECK (high > 0),
  low           BIGINT NOT NULL CHECK (low > 0),
  close         BIGINT NOT NULL CHECK (close > 0),
  volume        BIGINT NOT NULL CHECK (volume >= 0),
  -- The exchange cannot print a high below the low, so neither can we.
  CONSTRAINT candle_ohlc_consistent CHECK (high >= low),
  PRIMARY KEY (symbol, interval, ts)
);

CREATE INDEX IF NOT EXISTS candle_symbol_interval_ts_idx ON candle (symbol, interval, ts DESC);

CREATE TABLE IF NOT EXISTS corporate_action (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('SPLIT', 'BONUS', 'DIVIDEND')),
  ex_date       BIGINT NOT NULL,
  ratio         DOUBLE PRECISION,
  amount        BIGINT,
  UNIQUE (symbol, kind, ex_date)
);

-- ---------------------------------------------------------------------------
-- Orders, fills, trades, positions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "order" (
  id                TEXT PRIMARY KEY,
  -- The duplicate-prevention guarantee, enforced by the database rather than
  -- only by application memory: a restarted or duplicated process physically
  -- cannot insert the same intent twice.
  idempotency_key   TEXT NOT NULL UNIQUE,
  broker_order_id   TEXT,
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  order_type        TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT')),
  product           TEXT NOT NULL CHECK (product IN ('CNC', 'MIS', 'NRML')),
  time_in_force     TEXT NOT NULL CHECK (time_in_force IN ('DAY', 'IOC')),
  limit_price       BIGINT,
  trigger_price     BIGINT,
  strategy_id       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('PENDING_NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED')),
  filled_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price BIGINT,
  rejection_reason  TEXT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  CONSTRAINT order_fill_not_over CHECK (filled_quantity <= quantity)
);

CREATE INDEX IF NOT EXISTS order_status_idx ON "order" (status) WHERE status NOT IN ('FILLED', 'CANCELLED', 'REJECTED');
CREATE INDEX IF NOT EXISTS order_symbol_created_idx ON "order" (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS order_strategy_idx ON "order" (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fill (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES "order" (id) ON DELETE RESTRICT,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  price         BIGINT NOT NULL CHECK (price > 0),
  commission    BIGINT NOT NULL DEFAULT 0,
  ts            BIGINT NOT NULL,
  -- Exchanges and reconciliation both replay fills; this makes folding the
  -- same one twice impossible rather than merely unlikely.
  UNIQUE (order_id, ts, quantity, price)
);

CREATE INDEX IF NOT EXISTS fill_ts_idx ON fill (ts DESC);

CREATE TABLE IF NOT EXISTS closed_trade (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol        TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  entry_price   BIGINT NOT NULL,
  exit_price    BIGINT NOT NULL,
  pnl           BIGINT NOT NULL,
  strategy_id   TEXT,
  closed_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS closed_trade_closed_at_idx ON closed_trade (closed_at DESC);

CREATE TABLE IF NOT EXISTS position (
  symbol          TEXT PRIMARY KEY,
  quantity        INTEGER NOT NULL,
  average_price   BIGINT NOT NULL,
  realised_pnl    BIGINT NOT NULL DEFAULT 0,
  last_price      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_point (
  ts            BIGINT PRIMARY KEY,
  equity        BIGINT NOT NULL,
  cash          BIGINT NOT NULL,
  realised_pnl  BIGINT NOT NULL,
  unrealised_pnl BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Strategies, models, runtime state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS strategy_config (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  symbols       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  allocation    BIGINT,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS model (
  id            TEXT NOT NULL,
  version       TEXT NOT NULL,
  feature_names TEXT[] NOT NULL,
  weights       DOUBLE PRECISION[] NOT NULL,
  bias          DOUBLE PRECISION NOT NULL,
  metrics       JSONB,
  promoted      BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at BIGINT NOT NULL,
  PRIMARY KEY (id, version)
);

-- At most one promoted model at a time; the registry's invariant, enforced
-- where two processes cannot race past it.
CREATE UNIQUE INDEX IF NOT EXISTS model_single_promoted_idx ON model ((promoted)) WHERE promoted;

CREATE TABLE IF NOT EXISTS runtime_state (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Audit log — append only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_record (
  sequence      BIGINT PRIMARY KEY,
  ts            BIGINT NOT NULL,
  type          TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload       JSONB NOT NULL,
  previous_hash TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS audit_correlation_idx ON audit_record (correlation_id, sequence);
CREATE INDEX IF NOT EXISTS audit_type_idx ON audit_record (type, sequence DESC);

CREATE OR REPLACE FUNCTION trading.audit_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_record is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON audit_record;
CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON audit_record
  FOR EACH ROW EXECUTE FUNCTION trading.audit_is_append_only();

-- ---------------------------------------------------------------------------
-- Reconciliation breaks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reconciliation_break (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      TEXT,
  detail        TEXT NOT NULL,
  detected_at   BIGINT NOT NULL,
  resolved_at   BIGINT,
  resolution    TEXT
);

CREATE INDEX IF NOT EXISTS reconciliation_open_idx ON reconciliation_break (detected_at DESC)
  WHERE resolved_at IS NULL;
