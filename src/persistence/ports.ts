/**
 * Persistence ports.
 *
 * The engine depends on these interfaces, never on `pg`. Two consequences that
 * are worth the indirection:
 *
 * - The backtester and the unit tests run against in-memory implementations,
 *   so the deterministic core stays testable without a database.
 * - The live system runs against Postgres with no change to any layer above.
 *
 * Every method takes and returns domain types (integer-paise money, epoch-ms
 * timestamps). Row shapes stay inside the adapters.
 */

import type {
  Candle,
  Fill,
  Interval,
  Order,
  OrderStatus,
  Position,
  Timestamp,
} from '../domain/types';
import type { Paise } from '../domain/money';
import type { AuditRecord, AuditEventType } from '../audit/log';
import type { ClosedTrade } from '../execution/portfolio';
import type { ValidationMetrics } from '../ai/types';

export interface OrderRepository {
  /** Inserts a new order. Rejects a duplicate idempotency key. */
  insert(order: Order): Promise<void>;
  update(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findByIdempotencyKey(key: string): Promise<Order | null>;
  /**
   * Resolves a broker's own order id to the platform's order.
   *
   * Needed on every incoming fill: brokers report against their identifiers,
   * the platform stores its own, and something has to bridge the two before a
   * fill can be attributed.
   */
  findByBrokerOrderId(brokerOrderId: string): Promise<Order | null>;
  /** Orders not in a terminal state — what reconciliation and recovery work on. */
  findOpen(): Promise<Order[]>;
  findRecent(limit: number): Promise<Order[]>;
}

export interface FillRepository {
  /** Idempotent: replaying the same fill is a no-op. Returns true if stored. */
  append(fill: Fill): Promise<boolean>;
  since(timestamp: Timestamp): Promise<Fill[]>;
  forOrder(orderId: string): Promise<Fill[]>;
}

export interface TradeRepository {
  append(trade: ClosedTrade, strategyId?: string): Promise<void>;
  recent(limit: number): Promise<ClosedTrade[]>;
  between(from: Timestamp, to: Timestamp): Promise<ClosedTrade[]>;
}

export interface PositionRepository {
  upsert(position: Position, at: Timestamp): Promise<void>;
  all(): Promise<Position[]>;
  /** Positions with a non-zero quantity. */
  open(): Promise<Position[]>;
  find(symbol: string): Promise<Position | null>;
}

export interface EquitySnapshot {
  readonly timestamp: Timestamp;
  readonly equity: Paise;
  readonly cash: Paise;
  readonly realisedPnl: Paise;
  readonly unrealisedPnl: Paise;
}

export interface EquityRepository {
  append(snapshot: EquitySnapshot): Promise<void>;
  between(from: Timestamp, to: Timestamp): Promise<EquitySnapshot[]>;
  latest(): Promise<EquitySnapshot | null>;
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>;
  /** Highest sequence written, for continuing the chain after a restart. */
  head(): Promise<AuditRecord | null>;
  byCorrelation(correlationId: string): Promise<AuditRecord[]>;
  byType(type: AuditEventType, limit: number): Promise<AuditRecord[]>;
  recent(limit: number): Promise<AuditRecord[]>;
}

export interface CandleRepository {
  /** Upserts a batch. Existing bars are replaced — corrected data must win. */
  upsertMany(candles: readonly Candle[]): Promise<number>;
  range(
    symbol: string,
    interval: Interval,
    from: Timestamp,
    to: Timestamp,
  ): Promise<Candle[]>;
  /** The most recent `limit` bars, returned oldest-first for indicator input. */
  latest(symbol: string, interval: Interval, limit: number): Promise<Candle[]>;
  symbols(): Promise<string[]>;
}

export interface StoredModel {
  readonly id: string;
  readonly version: string;
  readonly featureNames: readonly string[];
  readonly weights: readonly number[];
  readonly bias: number;
  readonly metrics?: ValidationMetrics;
  readonly promoted: boolean;
  readonly registeredAt: Timestamp;
}

export interface ModelRepository {
  save(model: StoredModel): Promise<void>;
  find(id: string, version: string): Promise<StoredModel | null>;
  /** The live model, or null. At most one can be promoted at a time. */
  promoted(): Promise<StoredModel | null>;
  /** Promotes atomically, demoting whatever was live. */
  promote(id: string, version: string): Promise<void>;
  demoteAll(): Promise<void>;
  all(): Promise<StoredModel[]>;
}

export interface RuntimeStateRepository {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, at: Timestamp): Promise<void>;
}

export interface ReconciliationBreakRecord {
  readonly id?: number;
  readonly orderId: string | null;
  readonly detail: string;
  readonly detectedAt: Timestamp;
  readonly resolvedAt?: Timestamp;
  readonly resolution?: string;
}

export interface ReconciliationRepository {
  record(entry: ReconciliationBreakRecord): Promise<void>;
  open(): Promise<ReconciliationBreakRecord[]>;
  resolve(id: number, resolution: string, at: Timestamp): Promise<void>;
}

/** Everything the runtime needs, bundled so wiring is one object. */
export interface Repositories {
  readonly orders: OrderRepository;
  readonly fills: FillRepository;
  readonly trades: TradeRepository;
  readonly positions: PositionRepository;
  readonly equity: EquityRepository;
  readonly audit: AuditRepository;
  readonly candles: CandleRepository;
  readonly models: ModelRepository;
  readonly state: RuntimeStateRepository;
  readonly reconciliation: ReconciliationRepository;
}

export class DuplicateKeyError extends Error {
  constructor(readonly key: string) {
    super(`an order with idempotency key ${key} already exists`);
    this.name = 'DuplicateKeyError';
  }
}
