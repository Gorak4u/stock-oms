/**
 * The trading service — one object that owns the live system's state.
 *
 * Everything below it (strategies, risk, OMS, portfolio) is already built and
 * tested. This layer's job is composition and durability: rebuild state from
 * the database on startup, keep it in step as fills arrive, and expose a small
 * surface the API and the runner both drive.
 *
 * Startup rebuilds the portfolio by **replaying stored fills**, not by loading
 * a saved position row. Positions are derived data; replaying the fills that
 * produced them means a corrupted or stale position row cannot survive a
 * restart, and the equity curve after a restart matches the one before it.
 */

import type { AutomationMode, Candle, Fill, Order, Timestamp } from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';
import { InMemoryAuditLog, type AuditRecord, type AuditEventType } from '../audit/log';
import { Portfolio, type ClosedTrade } from '../execution/portfolio';
import { OrderManager } from '../execution/oms';
import type { BrokerConnector } from '../execution/broker';
import { RiskEngine } from '../risk/engine';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../risk/types';
import { MarketCalendar, NSE_HOLIDAYS_2026 } from '../marketdata/calendar';
import { TradingPipeline, type PipelineOutcome } from '../pipeline/tradingPipeline';
import type { Strategy } from '../strategy/types';
import { TrendFollowingStrategy } from '../strategy/trendFollowing';
import { MeanReversionStrategy } from '../strategy/meanReversion';
import { MomentumStrategy } from '../strategy/momentum';
import { VolatilityBreakoutStrategy } from '../strategy/volatility';
import type { Repositories } from '../persistence/ports';
import { MetricsRegistry, METRICS, type AlertManager } from '../monitoring/metrics';

export type StrategyKind = 'trend' | 'meanReversion' | 'momentum' | 'volatility';

export function buildStrategy(kind: StrategyKind, params: Record<string, number> = {}): Strategy<unknown> {
  switch (kind) {
    case 'trend': return new TrendFollowingStrategy(params);
    case 'meanReversion': return new MeanReversionStrategy(params);
    case 'momentum': return new MomentumStrategy(params);
    case 'volatility': return new VolatilityBreakoutStrategy(params);
  }
}

const STATE_KEYS = {
  mode: 'automation.mode',
  openingCash: 'account.openingCash',
  peakEquity: 'account.peakEquity',
  killSwitch: 'risk.killSwitch',
} as const;

interface PersistedKillSwitch {
  readonly engaged: boolean;
  readonly reason: string;
  readonly since: number | null;
}

export interface TradingServiceConfig {
  readonly repositories: Repositories;
  readonly broker: BrokerConnector;
  readonly limits?: RiskLimits;
  readonly openingCash: Paise;
  readonly strategyKind?: StrategyKind;
  readonly strategyParams?: Record<string, number>;
  readonly symbols?: readonly string[];
  readonly metrics?: MetricsRegistry;
  readonly alerts?: AlertManager;
  readonly calendar?: MarketCalendar;
}

/**
 * Audit sink that writes to both the in-memory chain and the database.
 *
 * The chain is computed in memory (where the hashing lives) and persisted as
 * it grows, so the durable log carries the same hashes the verifier checks.
 */
class DurableAuditLog extends InMemoryAuditLog {
  constructor(private readonly repositories: Repositories) {
    super();
  }

  override append(
    type: AuditEventType,
    correlationId: string,
    payload: Record<string, unknown>,
    timestamp: Timestamp,
  ): AuditRecord {
    const record = super.append(type, correlationId, payload, timestamp);
    // Fire-and-forget: an audit write must never block an order decision, but
    // a failure to persist is itself worth surfacing.
    void this.repositories.audit.append(record).catch((error: unknown) => {
      console.error('failed to persist audit record', record.sequence, error);
    });
    return record;
  }
}

export class TradingService {
  readonly portfolio: Portfolio;
  readonly oms: OrderManager;
  readonly risk: RiskEngine;
  readonly pipeline: TradingPipeline;
  readonly audit: DurableAuditLog;
  readonly calendar: MarketCalendar;
  readonly metrics: MetricsRegistry;

  private readonly repositories: Repositories;
  private readonly broker: BrokerConnector;
  private readonly symbols: string[];
  private strategyKind: StrategyKind;
  private started = false;

  constructor(private readonly config: TradingServiceConfig) {
    this.repositories = config.repositories;
    this.broker = config.broker;
    this.metrics = config.metrics ?? new MetricsRegistry();
    this.calendar = config.calendar ?? new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 });
    this.symbols = [...(config.symbols ?? [])];
    this.strategyKind = config.strategyKind ?? 'trend';

    this.portfolio = new Portfolio(config.openingCash);
    this.audit = new DurableAuditLog(this.repositories);
    this.risk = new RiskEngine(config.limits ?? DEFAULT_RISK_LIMITS);
    this.oms = new OrderManager({ broker: this.broker, audit: this.audit });

    this.pipeline = new TradingPipeline({
      strategy: buildStrategy(this.strategyKind, config.strategyParams ?? {}),
      risk: this.risk,
      oms: this.oms,
      portfolio: this.portfolio,
      calendar: this.calendar,
      audit: this.audit,
      limits: config.limits ?? DEFAULT_RISK_LIMITS,
      mode: 'MANUAL',
    });

    this.describeMetrics();
  }

  private describeMetrics(): void {
    this.metrics.describe(METRICS.equity, 'gauge', 'Account equity in paise');
    this.metrics.describe(METRICS.dayPnl, 'gauge', 'Profit and loss since start of day, in paise');
    this.metrics.describe(METRICS.openPositions, 'gauge', 'Number of open positions');
    this.metrics.describe(METRICS.killSwitch, 'gauge', 'Emergency stop engaged (1) or clear (0)');
    this.metrics.describe(METRICS.ordersSubmitted, 'counter', 'Orders sent to the broker');
    this.metrics.describe(METRICS.riskRejections, 'counter', 'Signals refused by the risk layer');
    this.metrics.describe(METRICS.signalsGenerated, 'counter', 'Signals produced by strategies');
  }

  /**
   * Rebuilds state from storage.
   *
   * Safe to call on every boot: replaying fills is deterministic, so a restart
   * mid-session lands on exactly the state the process had before it died.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Continue the audit chain rather than restarting it. A fresh chain would
    // collide with the sequences already stored and silently fork the hash
    // chain, so the durable log would stop verifying end to end.
    const head = await this.repositories.audit.head();
    if (head) this.audit.resumeFrom(head.sequence, head.hash);

    const storedMode = await this.repositories.state.get<AutomationMode>(STATE_KEYS.mode);
    if (storedMode) this.pipeline.setMode(storedMode, Date.now(), 'startup-restore');

    // An engaged emergency stop must survive a restart. Otherwise a crash —
    // or a deliberate restart — silently resumes trading that a human had
    // stopped, which is precisely the situation the stop exists to prevent.
    // Clearing it stays a deliberate, manual act.
    const storedStop = await this.repositories.state.get<PersistedKillSwitch>(STATE_KEYS.killSwitch);
    if (storedStop?.engaged) {
      this.risk.killSwitch.engage(
        `${storedStop.reason} [restored on restart]`,
        storedStop.since ?? Date.now(),
      );
    }

    // Replay every fill in order. Positions and cash are derived, never loaded.
    const fills = await this.repositories.fills.since(0);
    for (const fill of fills) this.portfolio.applyFill(fill);

    const positions = await this.repositories.positions.open();
    for (const position of positions) this.portfolio.mark(position.symbol, position.lastPrice);

    await this.oms.reconcile('startup');
    // Publish an equity point and the gauges immediately, so /metrics and the
    // equity curve are populated from boot rather than only after the first
    // bar — a dashboard showing nothing looks identical to one showing zero.
    await this.snapshot(Date.now());
    this.started = true;

    this.audit.append(
      'MODE_CHANGED',
      'startup',
      { mode: this.pipeline.automationMode, replayedFills: fills.length },
      Date.now(),
    );
  }

  /** Feeds a bar through the pipeline and persists whatever changed. */
  async onBar(symbol: string, candles: readonly Candle[]): Promise<PipelineOutcome> {
    const outcome = await this.pipeline.onBar(symbol, candles);
    const now = candles[candles.length - 1]?.timestamp ?? Date.now();

    if (outcome.kind === 'SUBMITTED') {
      this.metrics.increment(METRICS.ordersSubmitted, { symbol });
      const order = this.oms.getOrder(outcome.orderId);
      if (order) await this.persistOrder(order);
    }
    if (outcome.kind === 'RISK_REJECTED') {
      for (const reason of outcome.reasons) {
        this.metrics.increment(METRICS.riskRejections, { code: reason.split(':')[0]!.trim() });
      }
    }
    if (outcome.kind !== 'NO_SIGNAL') {
      this.metrics.increment(METRICS.signalsGenerated, { symbol });
    }

    await this.snapshot(now);
    return outcome;
  }

  /** Applies a fill from the broker, updating orders, positions and P&L. */
  async applyFill(fill: Fill): Promise<ClosedTrade | null> {
    const isNew = await this.repositories.fills.append(fill);
    if (!isNew) return null; // already folded in — replay is a no-op

    // The OMS holds orders in memory, so after a restart it has no record of
    // an order placed before it. The fill is still real money and must reach
    // the portfolio regardless — dropping it would leave the platform trading
    // against a position it does not know it has. The order-state update is
    // best-effort, and an unknown order is recorded as a reconciliation break
    // rather than thrown, which would take down the whole fill path.
    if (this.oms.getOrder(fill.orderId)) {
      this.oms.applyFill(fill, `fill-${fill.orderId}`);
    } else {
      await this.repositories.reconciliation.record({
        orderId: fill.orderId,
        detail:
          `fill received for order ${fill.orderId}, which the order manager has no record of ` +
          '(placed before a restart, or by another process) — applied to the portfolio anyway',
        detectedAt: fill.timestamp,
      });
    }

    const closed = this.portfolio.applyFill(fill);

    const order = this.oms.getOrder(fill.orderId);
    if (order) await this.persistOrder(order);

    if (closed) {
      await this.repositories.trades.append(closed);
      this.pipeline.recordTradeOutcome(closed.pnl, fill.timestamp);
    }

    const position = this.portfolio.getPosition(fill.symbol);
    if (position) await this.repositories.positions.upsert(position, fill.timestamp);

    this.metrics.increment(METRICS.fillsReceived, { symbol: fill.symbol });
    await this.snapshot(fill.timestamp);

    return closed;
  }

  private async persistOrder(order: Order): Promise<void> {
    const existing = await this.repositories.orders.findById(order.id);
    if (existing) await this.repositories.orders.update(order);
    else await this.repositories.orders.insert(order).catch(() => undefined);
  }

  /** Writes an equity point and refreshes the gauges. */
  async snapshot(at: Timestamp): Promise<void> {
    const snapshot = this.portfolio.snapshot();

    await this.repositories.equity.append({
      timestamp: at,
      equity: snapshot.equity,
      cash: snapshot.cash,
      realisedPnl: snapshot.realisedPnl,
      unrealisedPnl: snapshot.unrealisedPnl,
    });

    this.metrics.setGauge(METRICS.equity, snapshot.equity);
    this.metrics.setGauge(METRICS.openPositions, snapshot.positions.length);
    this.metrics.setGauge(METRICS.killSwitch, this.risk.killSwitch.isEngaged ? 1 : 0);
  }

  async setMode(mode: AutomationMode, actor: string): Promise<void> {
    this.pipeline.setMode(mode, Date.now(), actor);
    await this.repositories.state.set(STATE_KEYS.mode, mode, Date.now());
  }

  async emergencyStop(reason: string, actor: string): Promise<void> {
    const at = Date.now();
    this.pipeline.emergencyStop(`${reason} (by ${actor})`, at);
    this.metrics.setGauge(METRICS.killSwitch, 1);

    await this.repositories.state.set<PersistedKillSwitch>(
      STATE_KEYS.killSwitch,
      { engaged: true, reason: `${reason} (by ${actor})`, since: at },
      at,
    );

    await this.config.alerts?.dispatch({
      severity: 'critical',
      title: 'Emergency stop engaged',
      detail: `${reason} (by ${actor})`,
      at: Date.now(),
    });
  }

  async releaseEmergencyStop(actor: string): Promise<void> {
    const at = Date.now();
    this.pipeline.releaseEmergencyStop(at, actor);
    this.metrics.setGauge(METRICS.killSwitch, 0);

    await this.repositories.state.set<PersistedKillSwitch>(
      STATE_KEYS.killSwitch,
      { engaged: false, reason: '', since: null },
      at,
    );
  }

  get watchlist(): readonly string[] {
    return this.symbols;
  }

  addSymbol(symbol: string): void {
    if (!this.symbols.includes(symbol)) this.symbols.push(symbol);
  }

  removeSymbol(symbol: string): void {
    const index = this.symbols.indexOf(symbol);
    if (index >= 0) this.symbols.splice(index, 1);
  }

  get currentStrategy(): StrategyKind {
    return this.strategyKind;
  }

  /** Current state, for the API and the dashboard. */
  status(): {
    mode: AutomationMode;
    killSwitch: { engaged: boolean; reason: string; since: number | null };
    equity: Paise;
    cash: Paise;
    realisedPnl: Paise;
    unrealisedPnl: Paise;
    openPositions: number;
    pendingApprovals: number;
    strategy: StrategyKind;
    symbols: readonly string[];
    lossStreak: { streak: number; trippedAt: number | null };
  } {
    const snapshot = this.portfolio.snapshot();
    return {
      mode: this.pipeline.automationMode,
      killSwitch: this.risk.killSwitch.state,
      equity: snapshot.equity,
      cash: snapshot.cash,
      realisedPnl: snapshot.realisedPnl,
      unrealisedPnl: snapshot.unrealisedPnl,
      openPositions: snapshot.positions.length,
      pendingApprovals: this.pipeline.pendingApprovals().length,
      strategy: this.strategyKind,
      symbols: this.symbols,
      lossStreak: this.pipeline.lossStreak,
    };
  }
}

export { fromPaise, STATE_KEYS };
