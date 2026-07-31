/**
 * Backtest engine — the trading workflow run against history.
 *
 * It drives the *same* strategy, AI, risk, sizing and fill components the live
 * path uses. Anything simulated here that is re-implemented for live trading is
 * a place the two can silently disagree, so the only simulated pieces are the
 * clock and the exchange.
 *
 * Three rules keep the results honest:
 *
 * 1. **Decide on close, execute on the next open.** A signal computed from a
 *    bar's close cannot also be filled at that close — that price is only
 *    known once the bar is over. Every order is filled on the following bar.
 *
 * 2. **The adverse extreme happens first.** Within a bar, the low is fed before
 *    the high when long and the high before the low when short. Real intrabar
 *    paths are unknown; assuming the favourable one produces backtests that
 *    cannot be reproduced live.
 *
 * 3. **Costs and slippage always apply.** See `execution/costs.ts` — a strategy
 *    that is only profitable gross is not profitable.
 */

import type { Candle, Signal, Timestamp } from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';
import { Portfolio, type ClosedTrade } from '../execution/portfolio';
import { PaperBroker } from '../execution/paperBroker';
import { DEFAULT_COST_SCHEDULE, type CostSchedule } from '../execution/costs';
import { OrderManager, idempotencyKeyFor } from '../execution/oms';
import { LossStreakBreaker, RiskEngine } from '../risk/engine';
import { DEFAULT_RISK_LIMITS, type AccountState, type RiskLimits } from '../risk/types';
import { isStopTriggered, sizePosition, trailStop } from '../risk/positionSizing';
import type { Strategy, StrategyContext } from '../strategy/types';
import type { InferenceEngine } from '../ai/inference';
import { InMemoryAuditLog } from '../audit/log';
import { computeMetrics, type EquityPoint, type PerformanceMetrics } from './metrics';

export interface BacktestConfig {
  readonly openingCash: Paise;
  readonly limits?: RiskLimits;
  readonly costSchedule?: CostSchedule;
  readonly slippageFraction?: number;
  /** Lot size per symbol; defaults to 1 (cash equity). */
  readonly lotSizes?: Readonly<Record<string, number>>;
  /** Ratchet stops in the direction of profit as price moves. */
  readonly useTrailingStops?: boolean;
  /** Trailing distance in ATR multiples; only used with `useTrailingStops`. */
  readonly trailingAtrMultiple?: number;
  /** Optional model gate between the strategy and risk layers. */
  readonly inference?: InferenceEngine;
  readonly periodsPerYear?: number;
}

export interface BacktestResult {
  readonly metrics: PerformanceMetrics;
  readonly curve: readonly EquityPoint[];
  readonly trades: readonly ClosedTrade[];
  readonly signals: readonly Signal[];
  /** Signals the risk layer refused, with the reason. */
  readonly riskRejections: readonly { signal: Signal; reasons: string[] }[];
  /** Signals the model vetoed. */
  readonly modelVetoes: readonly { signal: Signal; reason: string }[];
  readonly audit: InMemoryAuditLog;
  readonly finalPortfolio: Portfolio;
}

interface OpenRisk {
  stop: Paise;
  direction: 'LONG' | 'SHORT';
}

interface PendingOrder {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly strategyId: string;
  readonly decisionBar: Timestamp;
  readonly stop?: Paise;
  readonly direction: 'LONG' | 'SHORT' | 'FLAT';
}

/**
 * Runs one strategy over one symbol's history.
 *
 * Single-symbol by design: portfolio-level allocation across symbols is a
 * separate concern, and conflating the two makes it impossible to tell whether
 * a result came from the strategy or from the allocator.
 */
export class BacktestEngine {
  private readonly limits: RiskLimits;

  constructor(private readonly config: BacktestConfig) {
    this.limits = config.limits ?? DEFAULT_RISK_LIMITS;
  }

  async run<P>(strategy: Strategy<P>, candles: readonly Candle[]): Promise<BacktestResult> {
    if (candles.length === 0) throw new Error('cannot backtest an empty series');

    const symbol = candles[0]!.symbol;
    const lotSize = this.config.lotSizes?.[symbol] ?? 1;

    const audit = new InMemoryAuditLog();
    const portfolio = new Portfolio(this.config.openingCash);
    const broker = new PaperBroker({
      slippageFraction: this.config.slippageFraction ?? 0.0005,
      costSchedule: this.config.costSchedule ?? DEFAULT_COST_SCHEDULE,
      openingCash: this.config.openingCash,
    });

    let clock: Timestamp = candles[0]!.timestamp;
    const oms = new OrderManager({ broker, audit, clock: () => clock });
    const risk = new RiskEngine(this.limits);

    // Fills flow straight into the portfolio so equity always reflects the
    // exchange's view rather than the intent's.
    const closedTrades: ClosedTrade[] = [];
    broker.onFill((fill) => {
      oms.applyFill(fill, `bar-${fill.timestamp}`);
      const closed = portfolio.applyFill(fill);
      if (closed) closedTrades.push(closed);
    });

    const prepared = strategy.prepare(candles);

    const curve: EquityPoint[] = [];
    const signals: Signal[] = [];
    const riskRejections: { signal: Signal; reasons: string[] }[] = [];
    const modelVetoes: { signal: Signal; reason: string }[] = [];

    let pending: PendingOrder | null = null;
    let openRisk: OpenRisk | null = null;

    let peakEquity = this.config.openingCash;
    let startOfDayEquity = this.config.openingCash;
    let currentDay = '';
    let barsInMarket = 0;
    let tradesSeen = 0;

    const lossBreaker = new LossStreakBreaker(
      this.limits.maxConsecutiveLosses,
      this.limits.consecutiveLossCooldownMs,
    );

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index]!;
      clock = candle.timestamp;
      broker.setClock(candle.timestamp);

      const day = new Date(candle.timestamp).toISOString().slice(0, 10);
      if (day !== currentDay) {
        currentDay = day;
        startOfDayEquity = portfolio.equity;
      }

      // --- 1. Fill what the previous bar decided, at this bar's open. --------
      broker.setPrice(symbol, candle.open);
      if (pending) {
        await this.submitPending(oms, pending, candle, lotSize);
        // Re-publish the open so the freshly acknowledged order is worked. The
        // broker deliberately does not fill inside `submit` — see PaperBroker.
        broker.setPrice(symbol, candle.open);
        if (pending.direction !== 'FLAT' && pending.stop !== undefined) {
          openRisk = { stop: pending.stop, direction: pending.direction };
        }
        pending = null;
      }

      // --- 2. Walk the bar, adverse extreme first. --------------------------
      const position = portfolio.getPosition(symbol);
      const isShort = (position?.quantity ?? 0) < 0;
      const [first, second] = isShort ? [candle.high, candle.low] : [candle.low, candle.high];

      broker.setPrice(symbol, first);
      portfolio.mark(symbol, first);
      openRisk = await this.enforceStop(oms, broker, portfolio, symbol, first, openRisk, candle);

      broker.setPrice(symbol, second);
      portfolio.mark(symbol, second);
      openRisk = await this.enforceStop(oms, broker, portfolio, symbol, second, openRisk, candle);

      broker.setPrice(symbol, candle.close);
      portfolio.mark(symbol, candle.close);

      // --- 3. Track losing streaks for the circuit breaker. -----------------
      while (tradesSeen < closedTrades.length) {
        const trade = closedTrades[tradesSeen]!;
        lossBreaker.record(trade.pnl, trade.closedAt);
        tradesSeen += 1;
      }

      const equity = portfolio.equity;
      if (equity > peakEquity) peakEquity = equity;
      curve.push({ timestamp: candle.timestamp, equity });

      const held = portfolio.getPosition(symbol);
      if (held && held.quantity !== 0) {
        barsInMarket += 1;
        if (this.config.useTrailingStops && openRisk) {
          openRisk = this.updateTrailingStop(openRisk, candle);
        }
      } else {
        openRisk = null;
      }

      // --- 4. Decide on this bar's close, for the next bar's open. ----------
      if (index >= candles.length - 1) break;

      const context: StrategyContext = {
        symbol,
        candles,
        index,
        position: held,
        now: candle.timestamp,
        minutesToClose: 0,
      };

      const raw = strategy.evaluate(context, prepared);
      if (!raw) continue;

      signals.push(raw);
      audit.append(
        'SIGNAL_GENERATED',
        `bar-${candle.timestamp}`,
        { signal: raw },
        candle.timestamp,
      );

      if (this.config.inference) {
        const gated = this.config.inference.gate(raw, candles, index);
        if (!gated.allowed) {
          modelVetoes.push({ signal: raw, reason: gated.reason });
          continue;
        }
      }

      pending = this.planOrder(raw, portfolio, risk, symbol, lotSize, peakEquity, {
        startOfDayEquity,
        consecutiveLosses: lossBreaker.effectiveStreak(candle.timestamp),
        recentOrderTimestamps: oms.recentSubmissions(candle.timestamp),
        onRejection: (reasons) => riskRejections.push({ signal: raw, reasons }),
        audit,
        now: candle.timestamp,
      });
    }

    const metrics = computeMetrics({
      curve,
      trades: closedTrades,
      barsInMarket,
      ...(this.config.periodsPerYear !== undefined
        ? { periodsPerYear: this.config.periodsPerYear }
        : {}),
    });

    return {
      metrics,
      curve,
      trades: closedTrades,
      signals,
      riskRejections,
      modelVetoes,
      audit,
      finalPortfolio: portfolio,
    };
  }

  /** Turns an approved signal into a sized order for the next bar. */
  private planOrder(
    signal: Signal,
    portfolio: Portfolio,
    risk: RiskEngine,
    symbol: string,
    lotSize: number,
    peakEquity: Paise,
    extra: {
      startOfDayEquity: Paise;
      consecutiveLosses: number;
      recentOrderTimestamps: Timestamp[];
      onRejection: (reasons: string[]) => void;
      audit: InMemoryAuditLog;
      now: Timestamp;
    },
  ): PendingOrder | null {
    const position = portfolio.getPosition(symbol);
    const heldQuantity = position?.quantity ?? 0;

    // Exit: flatten whatever is open. Risk-reducing, so it is never resized.
    if (signal.direction === 'FLAT') {
      if (heldQuantity === 0) return null;
      return {
        symbol,
        side: heldQuantity > 0 ? 'SELL' : 'BUY',
        quantity: Math.abs(heldQuantity),
        strategyId: signal.strategyId,
        decisionBar: signal.timestamp,
        direction: 'FLAT',
      };
    }

    if (heldQuantity !== 0) return null;
    if (signal.stopLoss === undefined) return null;

    const equity = portfolio.equity;
    const sizing = sizePosition({
      equity,
      entryPrice: signal.referencePrice,
      stopLoss: signal.stopLoss,
      // Conviction scales within the risk budget; it can never exceed it.
      riskFraction: this.limits.riskPerTradeFraction * Math.max(0.25, signal.strength),
      maxPositionFraction: this.limits.maxPositionFraction,
      availableCash: portfolio.cash,
      lotSize,
    });

    if (sizing.quantity <= 0) {
      extra.onRejection([`position sizer returned zero (bound by ${sizing.boundBy})`]);
      return null;
    }

    const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const account: AccountState = {
      equity,
      availableCash: portfolio.cash,
      startOfDayEquity: extra.startOfDayEquity,
      peakEquity,
      positions: portfolio.getOpenPositions(),
      dayPnl: fromPaise(equity - extra.startOfDayEquity),
      consecutiveLosses: extra.consecutiveLosses,
      recentOrderTimestamps: extra.recentOrderTimestamps,
    };

    const decision = risk.evaluate(
      {
        request: {
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
        },
        referencePrice: signal.referencePrice,
        stopLoss: signal.stopLoss,
        now: extra.now,
        marketOpen: true,
        dataIsStale: false,
      },
      account,
    );

    if (!decision.approved) {
      const reasons = decision.rejections.map((r) => `${r.code}: ${r.detail}`);
      extra.onRejection(reasons);
      extra.audit.append(
        'RISK_REJECTED',
        `bar-${signal.timestamp}`,
        { signal, reasons },
        extra.now,
      );
      return null;
    }

    extra.audit.append(
      'RISK_APPROVED',
      `bar-${signal.timestamp}`,
      { signal, quantity: decision.approvedQuantity, adjustments: decision.adjustments },
      extra.now,
    );

    return {
      symbol,
      side,
      quantity: decision.approvedQuantity,
      strategyId: signal.strategyId,
      decisionBar: signal.timestamp,
      stop: signal.stopLoss,
      direction: signal.direction,
    };
  }

  private async submitPending(
    oms: OrderManager,
    pending: PendingOrder,
    candle: Candle,
    lotSize: number,
  ): Promise<void> {
    const quantity = Math.floor(pending.quantity / lotSize) * lotSize;
    if (quantity <= 0) return;

    const request = oms.buildRequest(
      {
        strategyId: pending.strategyId,
        symbol: pending.symbol,
        side: pending.side,
        quantity,
        decisionBar: pending.decisionBar,
      },
      { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' },
    );

    await oms.submit(request, `bar-${candle.timestamp}`);
  }

  /**
   * Closes a position whose stop has been reached.
   *
   * The exit is a market order at the price that triggered it, so a gap
   * through the stop fills at the gapped price — which is what happens in
   * reality, and is exactly the scenario a backtest must not gloss over.
   */
  private async enforceStop(
    oms: OrderManager,
    broker: PaperBroker,
    portfolio: Portfolio,
    symbol: string,
    price: Paise,
    openRisk: OpenRisk | null,
    candle: Candle,
  ): Promise<OpenRisk | null> {
    if (!openRisk) return null;

    const position = portfolio.getPosition(symbol);
    if (!position || position.quantity === 0) return null;
    if (!isStopTriggered(price, openRisk.stop, openRisk.direction)) return openRisk;

    const request = oms.buildRequest(
      {
        strategyId: 'risk-stop',
        symbol,
        side: position.quantity > 0 ? 'SELL' : 'BUY',
        quantity: Math.abs(position.quantity),
        decisionBar: candle.timestamp,
      },
      { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' },
    );

    await oms.submit(request, `stop-${candle.timestamp}`);
    broker.setPrice(symbol, price);
    return null;
  }

  /** Ratchets the stop toward profit; {@link trailStop} guarantees it never loosens. */
  private updateTrailingStop(openRisk: OpenRisk, candle: Candle): OpenRisk {
    const multiple = this.config.trailingAtrMultiple ?? 2;
    const barRange = Math.max(1, candle.high - candle.low);
    const distance = Math.round(barRange * multiple);

    const candidate = (
      openRisk.direction === 'LONG' ? candle.close - distance : candle.close + distance
    ) as Paise;

    return { ...openRisk, stop: trailStop(openRisk.stop, candidate, openRisk.direction) };
  }
}
