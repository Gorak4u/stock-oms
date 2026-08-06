/**
 * In-memory implementations of the persistence ports.
 *
 * Used by tests and by backtests, where a database would add nothing but
 * latency. They are held to the same contract as the Postgres adapters —
 * `__tests__/persistence.test.ts` runs one shared suite against both, so a
 * behavioural difference between them fails the build rather than surfacing
 * later as a production-only bug.
 */

import type { Candle, Fill, Interval, Order, Position, Timestamp } from '../domain/types';
import { fromPaise } from '../domain/money';
import type { AuditEventType, AuditRecord } from '../audit/log';
import type { ClosedTrade } from '../execution/portfolio';
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

export class MemoryOrderRepository implements OrderRepository {
  private readonly byId = new Map<string, Order>();
  private readonly byKey = new Map<string, string>();

  async insert(order: Order): Promise<void> {
    const key = order.request.idempotencyKey;
    if (this.byKey.has(key)) throw new DuplicateKeyError(key);
    this.byId.set(order.id, order);
    this.byKey.set(key, order.id);
  }

  async update(order: Order): Promise<void> {
    if (!this.byId.has(order.id)) throw new Error(`unknown order ${order.id}`);
    this.byId.set(order.id, order);
  }

  async findById(id: string): Promise<Order | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    const id = this.byKey.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findByBrokerOrderId(brokerOrderId: string): Promise<Order | null> {
    for (const order of this.byId.values()) {
      if (order.brokerOrderId === brokerOrderId) return order;
    }
    return null;
  }

  async findOpen(): Promise<Order[]> {
    return [...this.byId.values()]
      .filter((o) => !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async findRecent(limit: number): Promise<Order[]> {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
}

export class MemoryFillRepository implements FillRepository {
  private readonly fills: Fill[] = [];
  private readonly seen = new Set<string>();

  private static key(f: Fill): string {
    return `${f.orderId}|${f.timestamp}|${f.quantity}|${f.price}`;
  }

  async append(fill: Fill): Promise<boolean> {
    const key = MemoryFillRepository.key(fill);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.fills.push(fill);
    return true;
  }

  async since(timestamp: Timestamp): Promise<Fill[]> {
    return this.fills.filter((f) => f.timestamp >= timestamp).sort((a, b) => a.timestamp - b.timestamp);
  }

  async forOrder(orderId: string): Promise<Fill[]> {
    return this.fills.filter((f) => f.orderId === orderId).sort((a, b) => a.timestamp - b.timestamp);
  }
}

export class MemoryTradeRepository implements TradeRepository {
  private readonly trades: ClosedTrade[] = [];

  async append(trade: ClosedTrade): Promise<void> {
    this.trades.push(trade);
  }

  async recent(limit: number): Promise<ClosedTrade[]> {
    return [...this.trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, limit);
  }

  async between(from: Timestamp, to: Timestamp): Promise<ClosedTrade[]> {
    return this.trades
      .filter((t) => t.closedAt >= from && t.closedAt <= to)
      .sort((a, b) => a.closedAt - b.closedAt);
  }
}

export class MemoryPositionRepository implements PositionRepository {
  private readonly positions = new Map<string, Position>();

  /**
   * Unrealised P&L is derived, not stored.
   *
   * Recomputed from quantity, average price and the mark so it can never
   * contradict them — a caller passing a stale figure (or one with the wrong
   * sign for a short) would otherwise have it echoed straight back. Postgres
   * derives it the same way in its SELECT; the shared contract suite asserts
   * the two agree.
   */
  private static derive(position: Position): Position {
    return {
      ...position,
      unrealisedPnl: fromPaise(
        position.quantity === 0
          ? 0
          : position.quantity * (position.lastPrice - position.averagePrice),
      ),
    };
  }

  async upsert(position: Position): Promise<void> {
    this.positions.set(position.symbol, MemoryPositionRepository.derive(position));
  }

  async all(): Promise<Position[]> {
    return [...this.positions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async open(): Promise<Position[]> {
    return (await this.all()).filter((p) => p.quantity !== 0);
  }

  async find(symbol: string): Promise<Position | null> {
    return this.positions.get(symbol) ?? null;
  }
}

export class MemoryEquityRepository implements EquityRepository {
  private readonly points = new Map<Timestamp, EquitySnapshot>();

  async append(snapshot: EquitySnapshot): Promise<void> {
    this.points.set(snapshot.timestamp, snapshot);
  }

  async between(from: Timestamp, to: Timestamp): Promise<EquitySnapshot[]> {
    return [...this.points.values()]
      .filter((p) => p.timestamp >= from && p.timestamp <= to)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async latest(): Promise<EquitySnapshot | null> {
    const all = [...this.points.values()].sort((a, b) => b.timestamp - a.timestamp);
    return all[0] ?? null;
  }
}

export class MemoryAuditRepository implements AuditRepository {
  private readonly records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async head(): Promise<AuditRecord | null> {
    return this.records.length === 0 ? null : this.records[this.records.length - 1]!;
  }

  async byCorrelation(correlationId: string): Promise<AuditRecord[]> {
    return this.records.filter((r) => r.correlationId === correlationId);
  }

  async byType(type: AuditEventType, limit: number): Promise<AuditRecord[]> {
    return this.records.filter((r) => r.type === type).reverse().slice(0, limit);
  }

  async recent(limit: number): Promise<AuditRecord[]> {
    return [...this.records].reverse().slice(0, limit);
  }
}

export class MemoryCandleRepository implements CandleRepository {
  private readonly store = new Map<string, Map<Timestamp, Candle>>();

  private static key(symbol: string, interval: Interval): string {
    return `${symbol}|${interval}`;
  }

  async upsertMany(candles: readonly Candle[]): Promise<number> {
    for (const candle of candles) {
      const key = MemoryCandleRepository.key(candle.symbol, candle.interval);
      let series = this.store.get(key);
      if (!series) {
        series = new Map();
        this.store.set(key, series);
      }
      series.set(candle.timestamp, candle);
    }
    return candles.length;
  }

  async range(symbol: string, interval: Interval, from: Timestamp, to: Timestamp): Promise<Candle[]> {
    const series = this.store.get(MemoryCandleRepository.key(symbol, interval));
    if (!series) return [];
    return [...series.values()]
      .filter((c) => c.timestamp >= from && c.timestamp <= to)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async latest(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const series = this.store.get(MemoryCandleRepository.key(symbol, interval));
    if (!series) return [];
    return [...series.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
  }

  async symbols(): Promise<string[]> {
    const out = new Set<string>();
    for (const key of this.store.keys()) out.add(key.split('|')[0]!);
    return [...out].sort();
  }
}

export class MemoryModelRepository implements ModelRepository {
  private readonly models = new Map<string, StoredModel>();

  private static key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  async save(model: StoredModel): Promise<void> {
    this.models.set(MemoryModelRepository.key(model.id, model.version), model);
  }

  async find(id: string, version: string): Promise<StoredModel | null> {
    return this.models.get(MemoryModelRepository.key(id, version)) ?? null;
  }

  async promoted(): Promise<StoredModel | null> {
    for (const model of this.models.values()) if (model.promoted) return model;
    return null;
  }

  async promote(id: string, version: string): Promise<void> {
    const key = MemoryModelRepository.key(id, version);
    const target = this.models.get(key);
    if (!target) throw new Error(`model ${key} is not registered`);
    await this.demoteAll();
    this.models.set(key, { ...target, promoted: true });
  }

  async demoteAll(): Promise<void> {
    for (const [key, model] of this.models.entries()) {
      if (model.promoted) this.models.set(key, { ...model, promoted: false });
    }
  }

  async all(): Promise<StoredModel[]> {
    return [...this.models.values()].sort((a, b) => b.registeredAt - a.registeredAt);
  }
}

export class MemoryRuntimeStateRepository implements RuntimeStateRepository {
  private readonly state = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.state.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    // Round-tripped through JSON so callers cannot mutate stored state by
    // holding on to the object they passed in — matching what a real database
    // does, and what the shared contract suite asserts.
    this.state.set(key, JSON.parse(JSON.stringify(value)));
  }
}

export class MemoryReconciliationRepository implements ReconciliationRepository {
  private readonly entries: ReconciliationBreakRecord[] = [];
  private nextId = 1;

  async record(entry: ReconciliationBreakRecord): Promise<void> {
    this.entries.push({ ...entry, id: this.nextId });
    this.nextId += 1;
  }

  async open(): Promise<ReconciliationBreakRecord[]> {
    return this.entries
      .filter((e) => e.resolvedAt === undefined)
      .sort((a, b) => b.detectedAt - a.detectedAt);
  }

  async resolve(id: number, resolution: string, at: Timestamp): Promise<void> {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index >= 0) {
      this.entries[index] = { ...this.entries[index]!, resolvedAt: at, resolution };
    }
  }
}

export function memoryRepositories(): Repositories {
  return {
    orders: new MemoryOrderRepository(),
    fills: new MemoryFillRepository(),
    trades: new MemoryTradeRepository(),
    positions: new MemoryPositionRepository(),
    equity: new MemoryEquityRepository(),
    audit: new MemoryAuditRepository(),
    candles: new MemoryCandleRepository(),
    models: new MemoryModelRepository(),
    state: new MemoryRuntimeStateRepository(),
    reconciliation: new MemoryReconciliationRepository(),
  };
}

export { fromPaise };
