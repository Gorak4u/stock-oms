/**
 * The trading workflow spine.
 *
 *   market data → features → strategy → AI → risk → execution → broker
 *
 * The same components the backtester drives, wired for live use. The pipeline
 * itself holds no trading logic — it sequences the layers, enforces the
 * automation mode, and makes sure every step lands in the audit log. Keeping it
 * logic-free is what lets the backtest be evidence about live behaviour.
 */

import type {
  AutomationMode,
  Candle,
  OrderRequest,
  Signal,
  Timestamp,
} from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';
import type { MarketCalendar } from '../marketdata/calendar';
import { toIstDate } from '../marketdata/calendar';
import type { TickValidator } from '../marketdata/validation';
import type { Strategy, StrategyContext } from '../strategy/types';
import type { InferenceEngine } from '../ai/inference';
import { LossStreakBreaker, RiskEngine } from '../risk/engine';
import type { AccountState, RiskLimits } from '../risk/types';
import { sizePosition } from '../risk/positionSizing';
import { OrderManager, idempotencyKeyFor } from '../execution/oms';
import type { Portfolio } from '../execution/portfolio';
import type { AuditSink } from '../audit/log';

export type PipelineOutcome =
  | { readonly kind: 'NO_SIGNAL' }
  | { readonly kind: 'MODEL_VETOED'; readonly signal: Signal; readonly reason: string }
  | { readonly kind: 'RISK_REJECTED'; readonly signal: Signal; readonly reasons: readonly string[] }
  | { readonly kind: 'SIZED_TO_ZERO'; readonly signal: Signal; readonly reason: string }
  | {
      /** Staged for a human to approve — `APPROVAL` mode, or `MANUAL`. */
      readonly kind: 'AWAITING_APPROVAL';
      readonly signal: Signal;
      readonly request: OrderRequest;
    }
  | { readonly kind: 'SUBMITTED'; readonly signal: Signal; readonly orderId: string }
  | { readonly kind: 'SUBMIT_REFUSED'; readonly signal: Signal; readonly reason: string };

export interface PipelineConfig {
  readonly strategy: Strategy<unknown>;
  readonly risk: RiskEngine;
  readonly oms: OrderManager;
  readonly portfolio: Portfolio;
  readonly calendar: MarketCalendar;
  readonly audit: AuditSink;
  readonly limits: RiskLimits;
  readonly mode: AutomationMode;
  readonly inference?: InferenceEngine;
  /** Per-symbol staleness monitors from the market-data layer. */
  readonly validators?: Readonly<Record<string, TickValidator>>;
  readonly lotSizes?: Readonly<Record<string, number>>;
}

export interface PendingApproval {
  readonly request: OrderRequest;
  readonly signal: Signal;
  readonly stagedAt: Timestamp;
}

export class TradingPipeline {
  private mode: AutomationMode;
  private readonly approvals = new Map<string, PendingApproval>();
  private startOfDayEquity: Paise;
  private peakEquity: Paise;
  private currentDay = '';
  private preparedCache = new WeakMap<object, unknown>();
  private readonly lossBreaker: LossStreakBreaker;

  constructor(private readonly config: PipelineConfig) {
    this.mode = config.mode;
    this.startOfDayEquity = config.portfolio.equity;
    this.peakEquity = config.portfolio.equity;
    this.lossBreaker = new LossStreakBreaker(
      config.limits.maxConsecutiveLosses,
      config.limits.consecutiveLossCooldownMs,
    );
  }

  /**
   * Changes the automation mode.
   *
   * Audited, because "who turned automatic trading on and when" is the first
   * question asked after an incident.
   */
  setMode(mode: AutomationMode, at: Timestamp, actor = 'operator'): void {
    const previous = this.mode;
    this.mode = mode;
    this.config.audit.append('MODE_CHANGED', 'pipeline', { previous, mode, actor }, at);
  }

  get automationMode(): AutomationMode {
    return this.mode;
  }

  /**
   * Runs one bar through the workflow.
   *
   * `candles` must end at the bar being decided on — the pipeline reads index
   * `candles.length - 1` and nothing beyond it.
   */
  async onBar(symbol: string, candles: readonly Candle[]): Promise<PipelineOutcome> {
    const index = candles.length - 1;
    const candle = candles[index];
    if (!candle) return { kind: 'NO_SIGNAL' };

    const now = candle.timestamp;
    this.rollDay(now);

    const portfolio = this.config.portfolio;
    portfolio.mark(symbol, candle.close);

    const equity = portfolio.equity;
    if (equity > this.peakEquity) this.peakEquity = equity;

    // Halt conditions are checked every bar, not only when an order appears —
    // a limit breached at 10:00 must stop trading at 10:00.
    const account = this.buildAccountState(now);
    const breaches = this.config.risk.checkHaltConditions(account, now);
    for (const breach of breaches) {
      this.config.audit.append('BREAKER_TRIPPED', 'pipeline', { breach }, now);
    }

    const prepared = this.prepare(candles);
    const context: StrategyContext = {
      symbol,
      candles,
      index,
      position: portfolio.getPosition(symbol),
      now,
      minutesToClose: this.config.calendar.minutesToClose(now),
    };

    const signal = this.config.strategy.evaluate(context, prepared);
    if (!signal) return { kind: 'NO_SIGNAL' };

    const correlationId = `${symbol}-${now}`;
    this.config.audit.append('SIGNAL_GENERATED', correlationId, { signal }, now);

    if (this.config.inference) {
      const gated = this.config.inference.gate(signal, candles, index);
      if (!gated.allowed) {
        return { kind: 'MODEL_VETOED', signal, reason: gated.reason };
      }
    }

    const request = this.buildRequest(signal, symbol, now);
    if (!request) {
      return { kind: 'SIZED_TO_ZERO', signal, reason: 'position sizer returned zero' };
    }

    const decision = this.config.risk.evaluate(
      {
        request,
        referencePrice: signal.referencePrice,
        ...(signal.stopLoss !== undefined ? { stopLoss: signal.stopLoss } : {}),
        now,
        marketOpen: this.config.calendar.isMarketOpen(now),
        dataIsStale: this.config.validators?.[symbol]?.isStale(now) ?? false,
      },
      this.buildAccountState(now),
    );

    if (!decision.approved) {
      const reasons = decision.rejections.map((r) => `${r.code}: ${r.detail}`);
      this.config.audit.append('RISK_REJECTED', correlationId, { signal, reasons }, now);
      return { kind: 'RISK_REJECTED', signal, reasons };
    }

    // Risk may have scaled the order down; re-derive the key so it matches the
    // quantity actually sent, and stays reproducible on a retry.
    const approved: OrderRequest = {
      ...request,
      quantity: decision.approvedQuantity,
      idempotencyKey: idempotencyKeyFor({
        strategyId: request.strategyId,
        symbol,
        side: request.side,
        quantity: decision.approvedQuantity,
        decisionBar: signal.timestamp,
      }),
    };

    this.config.audit.append(
      'RISK_APPROVED',
      correlationId,
      { quantity: approved.quantity, adjustments: decision.adjustments },
      now,
    );

    if (this.mode !== 'AUTOMATIC') {
      this.approvals.set(approved.idempotencyKey, {
        request: approved,
        signal,
        stagedAt: now,
      });
      this.config.audit.append(
        'ORDER_STAGED',
        correlationId,
        { request: approved, mode: this.mode },
        now,
      );
      return { kind: 'AWAITING_APPROVAL', signal, request: approved };
    }

    const result = await this.config.oms.submit(approved, correlationId);
    if (!result.submitted) {
      return {
        kind: 'SUBMIT_REFUSED',
        signal,
        reason: result.refusedReason ?? 'broker refused the order',
      };
    }

    return { kind: 'SUBMITTED', signal, orderId: result.order.id };
  }

  /**
   * Releases a staged order.
   *
   * Re-runs the risk check at approval time: a decision made minutes ago may
   * have been overtaken by a drawdown or a tripped breaker, and the stale
   * verdict must not be trusted.
   */
  async approve(idempotencyKey: string, now: Timestamp): Promise<PipelineOutcome> {
    const staged = this.approvals.get(idempotencyKey);
    if (!staged) {
      return { kind: 'NO_SIGNAL' };
    }

    const correlationId = `approval-${idempotencyKey}`;
    const decision = this.config.risk.evaluate(
      {
        request: staged.request,
        referencePrice: staged.signal.referencePrice,
        ...(staged.signal.stopLoss !== undefined ? { stopLoss: staged.signal.stopLoss } : {}),
        now,
        marketOpen: this.config.calendar.isMarketOpen(now),
        dataIsStale: this.config.validators?.[staged.request.symbol]?.isStale(now) ?? false,
      },
      this.buildAccountState(now),
    );

    if (!decision.approved) {
      this.approvals.delete(idempotencyKey);
      const reasons = decision.rejections.map((r) => `${r.code}: ${r.detail}`);
      this.config.audit.append(
        'RISK_REJECTED',
        correlationId,
        { reasons, note: 're-checked at approval time' },
        now,
      );
      return { kind: 'RISK_REJECTED', signal: staged.signal, reasons };
    }

    this.approvals.delete(idempotencyKey);
    const result = await this.config.oms.submit(staged.request, correlationId);

    return result.submitted
      ? { kind: 'SUBMITTED', signal: staged.signal, orderId: result.order.id }
      : {
          kind: 'SUBMIT_REFUSED',
          signal: staged.signal,
          reason: result.refusedReason ?? 'broker refused the order',
        };
  }

  reject(idempotencyKey: string, now: Timestamp, reason: string): void {
    if (!this.approvals.delete(idempotencyKey)) return;
    this.config.audit.append(
      'ORDER_CANCELLED',
      `approval-${idempotencyKey}`,
      { reason, actor: 'operator' },
      now,
    );
  }

  pendingApprovals(): readonly PendingApproval[] {
    return [...this.approvals.values()];
  }

  /** Emergency stop. Blocks every risk-increasing order until manually released. */
  emergencyStop(reason: string, at: Timestamp): void {
    this.config.risk.killSwitch.engage(reason, at);
    this.config.audit.append('KILL_SWITCH_ENGAGED', 'pipeline', { reason }, at);
  }

  releaseEmergencyStop(at: Timestamp, actor = 'operator'): void {
    this.config.risk.killSwitch.release();
    this.config.audit.append('KILL_SWITCH_RELEASED', 'pipeline', { actor }, at);
  }

  /** Feeds a closed trade's result to the consecutive-loss breaker. */
  recordTradeOutcome(pnl: Paise, at: Timestamp): void {
    this.lossBreaker.record(pnl, at);
  }

  get lossStreak(): { streak: number; trippedAt: number | null } {
    return this.lossBreaker.state;
  }

  private rollDay(now: Timestamp): void {
    const day = toIstDate(now);
    if (day === this.currentDay) return;
    this.currentDay = day;
    this.startOfDayEquity = this.config.portfolio.equity;
  }

  private buildAccountState(now: Timestamp): AccountState {
    const portfolio = this.config.portfolio;
    const equity = portfolio.equity;

    return {
      equity,
      availableCash: portfolio.cash,
      startOfDayEquity: this.startOfDayEquity,
      peakEquity: this.peakEquity,
      positions: portfolio.getOpenPositions(),
      dayPnl: fromPaise(equity - this.startOfDayEquity),
      consecutiveLosses: this.lossBreaker.effectiveStreak(now),
      recentOrderTimestamps: this.config.oms.recentSubmissions(now),
    };
  }

  /** Builds the order for a signal, or `null` when it sizes to nothing. */
  private buildRequest(signal: Signal, symbol: string, now: Timestamp): OrderRequest | null {
    const portfolio = this.config.portfolio;
    const position = portfolio.getPosition(symbol);
    const heldQuantity = position?.quantity ?? 0;

    if (signal.direction === 'FLAT') {
      if (heldQuantity === 0) return null;
      const side = heldQuantity > 0 ? 'SELL' : 'BUY';
      const quantity = Math.abs(heldQuantity);
      return {
        symbol,
        side,
        quantity,
        orderType: 'MARKET',
        product: 'MIS',
        timeInForce: 'DAY',
        strategyId: signal.strategyId,
        idempotencyKey: idempotencyKeyFor({
          strategyId: signal.strategyId,
          symbol,
          side,
          quantity,
          decisionBar: signal.timestamp,
        }),
      };
    }

    if (heldQuantity !== 0) return null;
    if (signal.stopLoss === undefined) return null;

    const sizing = sizePosition({
      equity: portfolio.equity,
      entryPrice: signal.referencePrice,
      stopLoss: signal.stopLoss,
      riskFraction: this.config.limits.riskPerTradeFraction * Math.max(0.25, signal.strength),
      maxPositionFraction: this.config.limits.maxPositionFraction,
      availableCash: portfolio.cash,
      lotSize: this.config.lotSizes?.[symbol] ?? 1,
    });

    if (sizing.quantity <= 0) return null;

    const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    return {
      symbol,
      side,
      quantity: sizing.quantity,
      orderType: 'MARKET',
      product: 'MIS',
      timeInForce: 'DAY',
      strategyId: signal.strategyId,
      idempotencyKey: idempotencyKeyFor({
        strategyId: signal.strategyId,
        symbol,
        side,
        quantity: sizing.quantity,
        decisionBar: signal.timestamp,
      }),
    };
  }

  /** Caches `prepare` per series so a live loop does not recompute every bar. */
  private prepare(candles: readonly Candle[]): unknown {
    const key = candles as unknown as object;
    const cached = this.preparedCache.get(key);
    if (cached !== undefined) return cached;

    const prepared = this.config.strategy.prepare(candles);
    this.preparedCache.set(key, prepared as object);
    return prepared;
  }
}
