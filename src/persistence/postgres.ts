/**
 * Postgres adapters for the persistence ports.
 *
 * Money crosses the driver boundary as BIGINT, which `pg` returns as a string
 * to avoid silently truncating values beyond 2^53. Every read goes through
 * {@link toPaise}, which converts and asserts the result is a safe integer —
 * a paise value that quietly lost precision would corrupt P&L in a way no test
 * downstream could attribute.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Candle,
  Fill,
  Interval,
  Order,
  OrderStatus,
  Position,
  ProductType,
  Side,
  Timestamp,
  TimeInForce,
  OrderType,
} from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';
import type { AuditEventType, AuditRecord } from '../audit/log';
import type { ClosedTrade } from '../execution/portfolio';
import type { ValidationMetrics } from '../ai/types';
import {
  DuplicateKeyError,
  type AuditRepository,
  type CandleRepository,
  type EquityRepository,
  type EquitySnapshot,
  type FillRepository,
  type ModelRepository,
  type OrderRepository,
  type PositionRepository,
  type ReconciliationBreakRecord,
  type ReconciliationRepository,
  type Repositories,
  type RuntimeStateRepository,
  type StoredModel,
  type TradeRepository,
} from './ports';

/** Postgres unique-violation. Distinguishes "already exists" from a real failure. */
const UNIQUE_VIOLATION = '23505';

function toPaise(value: string | number | null): Paise {
  if (value === null) return 0 as Paise;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(n)) {
    throw new Error(`money value ${value} is not a safe integer — precision was lost`);
  }
  return fromPaise(n);
}

function toOptionalPaise(value: string | number | null): Paise | undefined {
  return value === null || value === undefined ? undefined : toPaise(value);
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`expected a finite number, got ${value}`);
  return n;
}

export class Database {
  readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config);
  }

  /** Applies the schema. Idempotent — every statement is IF NOT EXISTS or OR REPLACE. */
  async migrate(): Promise<void> {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  /** Runs `fn` inside a transaction, rolling back on any throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  repositories(): Repositories {
    return {
      orders: new PgOrderRepository(this.pool),
      fills: new PgFillRepository(this.pool),
      trades: new PgTradeRepository(this.pool),
      positions: new PgPositionRepository(this.pool),
      equity: new PgEquityRepository(this.pool),
      audit: new PgAuditRepository(this.pool),
      candles: new PgCandleRepository(this.pool),
      models: new PgModelRepository(this.pool),
      state: new PgRuntimeStateRepository(this.pool),
      reconciliation: new PgReconciliationRepository(this.pool),
    };
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  idempotency_key: string;
  broker_order_id: string | null;
  symbol: string;
  side: Side;
  quantity: number;
  order_type: OrderType;
  product: ProductType;
  time_in_force: TimeInForce;
  limit_price: string | null;
  trigger_price: string | null;
  strategy_id: string;
  status: OrderStatus;
  filled_quantity: number;
  average_fill_price: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToOrder(row: OrderRow): Order {
  const limitPrice = toOptionalPaise(row.limit_price);
  const triggerPrice = toOptionalPaise(row.trigger_price);
  const averageFillPrice = toOptionalPaise(row.average_fill_price);

  return {
    id: row.id,
    request: {
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      orderType: row.order_type,
      product: row.product,
      timeInForce: row.time_in_force,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      ...(triggerPrice !== undefined ? { triggerPrice } : {}),
      strategyId: row.strategy_id,
      idempotencyKey: row.idempotency_key,
    },
    status: row.status,
    ...(row.broker_order_id ? { brokerOrderId: row.broker_order_id } : {}),
    filledQuantity: row.filled_quantity,
    ...(averageFillPrice !== undefined ? { averageFillPrice } : {}),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
  };
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: Pool) {}

  async insert(order: Order): Promise<void> {
    const r = order.request;
    try {
      await this.pool.query(
        `INSERT INTO trading."order"
           (id, idempotency_key, broker_order_id, symbol, side, quantity, order_type, product,
            time_in_force, limit_price, trigger_price, strategy_id, status, filled_quantity,
            average_fill_price, rejection_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          order.id, r.idempotencyKey, order.brokerOrderId ?? null, r.symbol, r.side, r.quantity,
          r.orderType, r.product, r.timeInForce, r.limitPrice ?? null, r.triggerPrice ?? null,
          r.strategyId, order.status, order.filledQuantity, order.averageFillPrice ?? null,
          order.rejectionReason ?? null, order.createdAt, order.updatedAt,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateKeyError(r.idempotencyKey);
      }
      throw error;
    }
  }

  async update(order: Order): Promise<void> {
    await this.pool.query(
      `UPDATE trading."order"
          SET broker_order_id = $2, status = $3, filled_quantity = $4,
              average_fill_price = $5, rejection_reason = $6, updated_at = $7
        WHERE id = $1`,
      [
        order.id, order.brokerOrderId ?? null, order.status, order.filledQuantity,
        order.averageFillPrice ?? null, order.rejectionReason ?? null, order.updatedAt,
      ],
    );
  }

  async findById(id: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      'SELECT * FROM trading."order" WHERE id = $1', [id],
    );
    return rows[0] ? rowToOrder(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(
      'SELECT * FROM trading."order" WHERE idempotency_key = $1', [key],
    );
    return rows[0] ? rowToOrder(rows[0]) : null;
  }

  async findOpen(): Promise<Order[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT * FROM trading."order"
        WHERE status NOT IN ('FILLED','CANCELLED','REJECTED')
        ORDER BY created_at`,
    );
    return rows.map(rowToOrder);
  }

  async findRecent(limit: number): Promise<Order[]> {
    const { rows } = await this.pool.query<OrderRow>(
      'SELECT * FROM trading."order" ORDER BY created_at DESC LIMIT $1', [limit],
    );
    return rows.map(rowToOrder);
  }
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export class PgFillRepository implements FillRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * `ON CONFLICT DO NOTHING` against the natural key makes replay safe at the
   * storage layer, so a redelivered websocket fill cannot double a position.
   */
  async append(fill: Fill): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO trading.fill (order_id, symbol, side, quantity, price, commission, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id, ts, quantity, price) DO NOTHING`,
      [fill.orderId, fill.symbol, fill.side, fill.quantity, fill.price, fill.commission, fill.timestamp],
    );
    return (rowCount ?? 0) > 0;
  }

  private map(row: {
    order_id: string; symbol: string; side: Side; quantity: number;
    price: string; commission: string; ts: string;
  }): Fill {
    return {
      orderId: row.order_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      price: toPaise(row.price),
      commission: toPaise(row.commission),
      timestamp: toNumber(row.ts),
    };
  }

  async since(timestamp: Timestamp): Promise<Fill[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.fill WHERE ts >= $1 ORDER BY ts', [timestamp],
    );
    return rows.map((r) => this.map(r));
  }

  async forOrder(orderId: string): Promise<Fill[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.fill WHERE order_id = $1 ORDER BY ts', [orderId],
    );
    return rows.map((r) => this.map(r));
  }
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export class PgTradeRepository implements TradeRepository {
  constructor(private readonly pool: Pool) {}

  async append(trade: ClosedTrade, strategyId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.closed_trade
         (symbol, direction, quantity, entry_price, exit_price, pnl, strategy_id, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [trade.symbol, trade.direction, trade.quantity, trade.entryPrice, trade.exitPrice,
       trade.pnl, strategyId ?? null, trade.closedAt],
    );
  }

  private map(row: {
    symbol: string; direction: 'LONG' | 'SHORT'; quantity: number;
    entry_price: string; exit_price: string; pnl: string; closed_at: string;
  }): ClosedTrade {
    return {
      symbol: row.symbol,
      direction: row.direction,
      quantity: row.quantity,
      entryPrice: toPaise(row.entry_price),
      exitPrice: toPaise(row.exit_price),
      pnl: toPaise(row.pnl),
      closedAt: toNumber(row.closed_at),
    };
  }

  async recent(limit: number): Promise<ClosedTrade[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.closed_trade ORDER BY closed_at DESC LIMIT $1', [limit],
    );
    return rows.map((r) => this.map(r));
  }

  async between(from: Timestamp, to: Timestamp): Promise<ClosedTrade[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.closed_trade WHERE closed_at BETWEEN $1 AND $2 ORDER BY closed_at',
      [from, to],
    );
    return rows.map((r) => this.map(r));
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export class PgPositionRepository implements PositionRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(position: Position, at: Timestamp): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.position (symbol, quantity, average_price, realised_pnl, last_price, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (symbol) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         average_price = EXCLUDED.average_price,
         realised_pnl = EXCLUDED.realised_pnl,
         last_price = EXCLUDED.last_price,
         updated_at = EXCLUDED.updated_at`,
      [position.symbol, position.quantity, position.averagePrice, position.realisedPnl,
       position.lastPrice, at],
    );
  }

  private map(row: {
    symbol: string; quantity: number; average_price: string;
    realised_pnl: string; last_price: string;
  }): Position {
    const quantity = row.quantity;
    const averagePrice = toPaise(row.average_price);
    const lastPrice = toPaise(row.last_price);
    return {
      symbol: row.symbol,
      quantity,
      averagePrice,
      realisedPnl: toPaise(row.realised_pnl),
      unrealisedPnl: fromPaise(quantity === 0 ? 0 : quantity * (lastPrice - averagePrice)),
      lastPrice,
    };
  }

  async all(): Promise<Position[]> {
    const { rows } = await this.pool.query('SELECT * FROM trading.position ORDER BY symbol');
    return rows.map((r) => this.map(r));
  }

  async open(): Promise<Position[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.position WHERE quantity <> 0 ORDER BY symbol',
    );
    return rows.map((r) => this.map(r));
  }

  async find(symbol: string): Promise<Position | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.position WHERE symbol = $1', [symbol],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// Equity
// ---------------------------------------------------------------------------

export class PgEquityRepository implements EquityRepository {
  constructor(private readonly pool: Pool) {}

  async append(s: EquitySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.equity_point (ts, equity, cash, realised_pnl, unrealised_pnl)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ts) DO UPDATE SET
         equity = EXCLUDED.equity, cash = EXCLUDED.cash,
         realised_pnl = EXCLUDED.realised_pnl, unrealised_pnl = EXCLUDED.unrealised_pnl`,
      [s.timestamp, s.equity, s.cash, s.realisedPnl, s.unrealisedPnl],
    );
  }

  private map(row: {
    ts: string; equity: string; cash: string; realised_pnl: string; unrealised_pnl: string;
  }): EquitySnapshot {
    return {
      timestamp: toNumber(row.ts),
      equity: toPaise(row.equity),
      cash: toPaise(row.cash),
      realisedPnl: toPaise(row.realised_pnl),
      unrealisedPnl: toPaise(row.unrealised_pnl),
    };
  }

  async between(from: Timestamp, to: Timestamp): Promise<EquitySnapshot[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.equity_point WHERE ts BETWEEN $1 AND $2 ORDER BY ts', [from, to],
    );
    return rows.map((r) => this.map(r));
  }

  async latest(): Promise<EquitySnapshot | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.equity_point ORDER BY ts DESC LIMIT 1',
    );
    return rows[0] ? this.map(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async append(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.audit_record
         (sequence, ts, type, correlation_id, payload, previous_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.sequence, record.timestamp, record.type, record.correlationId,
       JSON.stringify(record.payload), record.previousHash, record.hash],
    );
  }

  private map(row: {
    sequence: string; ts: string; type: AuditEventType; correlation_id: string;
    payload: Record<string, unknown>; previous_hash: string; hash: string;
  }): AuditRecord {
    return {
      sequence: toNumber(row.sequence),
      timestamp: toNumber(row.ts),
      type: row.type,
      correlationId: row.correlation_id,
      payload: row.payload,
      previousHash: row.previous_hash,
      hash: row.hash,
    };
  }

  async head(): Promise<AuditRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.audit_record ORDER BY sequence DESC LIMIT 1',
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async byCorrelation(correlationId: string): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.audit_record WHERE correlation_id = $1 ORDER BY sequence',
      [correlationId],
    );
    return rows.map((r) => this.map(r));
  }

  async byType(type: AuditEventType, limit: number): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.audit_record WHERE type = $1 ORDER BY sequence DESC LIMIT $2',
      [type, limit],
    );
    return rows.map((r) => this.map(r));
  }

  async recent(limit: number): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.audit_record ORDER BY sequence DESC LIMIT $1', [limit],
    );
    return rows.map((r) => this.map(r));
  }
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export class PgCandleRepository implements CandleRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Bulk upsert via `unnest`, which sends the whole batch as one statement
   * instead of one round trip per bar — five years of daily data across a
   * watchlist is otherwise dominated by network latency.
   */
  async upsertMany(candles: readonly Candle[]): Promise<number> {
    if (candles.length === 0) return 0;

    const { rowCount } = await this.pool.query(
      `INSERT INTO trading.candle (symbol, interval, ts, open, high, low, close, volume)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::bigint[], $4::bigint[],
         $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
       ON CONFLICT (symbol, interval, ts) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume`,
      [
        candles.map((c) => c.symbol),
        candles.map((c) => c.interval),
        candles.map((c) => c.timestamp),
        candles.map((c) => c.open),
        candles.map((c) => c.high),
        candles.map((c) => c.low),
        candles.map((c) => c.close),
        candles.map((c) => c.volume),
      ],
    );
    return rowCount ?? 0;
  }

  private map(row: {
    symbol: string; interval: Interval; ts: string;
    open: string; high: string; low: string; close: string; volume: string;
  }): Candle {
    return {
      symbol: row.symbol,
      interval: row.interval,
      timestamp: toNumber(row.ts),
      open: toPaise(row.open),
      high: toPaise(row.high),
      low: toPaise(row.low),
      close: toPaise(row.close),
      volume: toNumber(row.volume),
    };
  }

  async range(symbol: string, interval: Interval, from: Timestamp, to: Timestamp): Promise<Candle[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM trading.candle
        WHERE symbol = $1 AND interval = $2 AND ts BETWEEN $3 AND $4
        ORDER BY ts`,
      [symbol, interval, from, to],
    );
    return rows.map((r) => this.map(r));
  }

  async latest(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM trading.candle
          WHERE symbol = $1 AND interval = $2
          ORDER BY ts DESC LIMIT $3
       ) recent ORDER BY ts`,
      [symbol, interval, limit],
    );
    return rows.map((r) => this.map(r));
  }

  async symbols(): Promise<string[]> {
    const { rows } = await this.pool.query<{ symbol: string }>(
      'SELECT DISTINCT symbol FROM trading.candle ORDER BY symbol',
    );
    return rows.map((r) => r.symbol);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export class PgModelRepository implements ModelRepository {
  constructor(private readonly pool: Pool) {}

  async save(model: StoredModel): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.model
         (id, version, feature_names, weights, bias, metrics, promoted, registered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id, version) DO UPDATE SET
         feature_names = EXCLUDED.feature_names, weights = EXCLUDED.weights,
         bias = EXCLUDED.bias, metrics = EXCLUDED.metrics`,
      [model.id, model.version, model.featureNames, model.weights, model.bias,
       model.metrics ? JSON.stringify(model.metrics) : null, model.promoted, model.registeredAt],
    );
  }

  private map(row: {
    id: string; version: string; feature_names: string[]; weights: number[];
    bias: number; metrics: ValidationMetrics | null; promoted: boolean; registered_at: string;
  }): StoredModel {
    return {
      id: row.id,
      version: row.version,
      featureNames: row.feature_names,
      weights: row.weights,
      bias: toNumber(row.bias),
      ...(row.metrics ? { metrics: row.metrics } : {}),
      promoted: row.promoted,
      registeredAt: toNumber(row.registered_at),
    };
  }

  async find(id: string, version: string): Promise<StoredModel | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM trading.model WHERE id = $1 AND version = $2', [id, version],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async promoted(): Promise<StoredModel | null> {
    const { rows } = await this.pool.query('SELECT * FROM trading.model WHERE promoted LIMIT 1');
    return rows[0] ? this.map(rows[0]) : null;
  }

  /**
   * Demote-then-promote in one transaction.
   *
   * The partial unique index permits only one promoted row, so doing these as
   * separate statements would let a concurrent promotion fail midway and leave
   * no live model at all.
   */
  async promote(id: string, version: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE trading.model SET promoted = FALSE WHERE promoted');
      const { rowCount } = await client.query(
        'UPDATE trading.model SET promoted = TRUE WHERE id = $1 AND version = $2', [id, version],
      );
      if ((rowCount ?? 0) === 0) throw new Error(`model ${id}@${version} is not registered`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async demoteAll(): Promise<void> {
    await this.pool.query('UPDATE trading.model SET promoted = FALSE WHERE promoted');
  }

  async all(): Promise<StoredModel[]> {
    const { rows } = await this.pool.query('SELECT * FROM trading.model ORDER BY registered_at DESC');
    return rows.map((r) => this.map(r));
  }
}

// ---------------------------------------------------------------------------
// Runtime state & reconciliation
// ---------------------------------------------------------------------------

export class PgRuntimeStateRepository implements RuntimeStateRepository {
  constructor(private readonly pool: Pool) {}

  async get<T>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query<{ value: T }>(
      'SELECT value FROM trading.runtime_state WHERE key = $1', [key],
    );
    return rows[0] ? rows[0].value : null;
  }

  async set<T>(key: string, value: T, at: Timestamp): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.runtime_state (key, value, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), at],
    );
  }
}

export class PgReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  async record(entry: ReconciliationBreakRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO trading.reconciliation_break (order_id, detail, detected_at)
       VALUES ($1,$2,$3)`,
      [entry.orderId, entry.detail, entry.detectedAt],
    );
  }

  async open(): Promise<ReconciliationBreakRecord[]> {
    const { rows } = await this.pool.query<{
      id: string; order_id: string | null; detail: string; detected_at: string;
    }>(
      'SELECT * FROM trading.reconciliation_break WHERE resolved_at IS NULL ORDER BY detected_at DESC',
    );
    return rows.map((r) => ({
      id: toNumber(r.id),
      orderId: r.order_id,
      detail: r.detail,
      detectedAt: toNumber(r.detected_at),
    }));
  }

  async resolve(id: number, resolution: string, at: Timestamp): Promise<void> {
    await this.pool.query(
      'UPDATE trading.reconciliation_break SET resolved_at = $2, resolution = $3 WHERE id = $1',
      [id, at, resolution],
    );
  }
}
