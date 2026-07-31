import type { OrderRequest, Position, Timestamp } from '../domain/types';
import type { Paise } from '../domain/money';

/** Every way the risk layer can refuse an order. Each maps to one configured control. */
export type RiskRejectionCode =
  | 'KILL_SWITCH_ENGAGED'
  | 'MARKET_CLOSED'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_DRAWDOWN'
  | 'MAX_GROSS_EXPOSURE'
  | 'MAX_NET_EXPOSURE'
  | 'MAX_POSITION_VALUE'
  | 'MAX_SYMBOL_CONCENTRATION'
  | 'STRATEGY_ALLOCATION_EXCEEDED'
  | 'INSUFFICIENT_CAPITAL'
  | 'MAX_OPEN_POSITIONS'
  | 'CONSECUTIVE_LOSS_BREAKER'
  | 'ORDER_RATE_BREAKER'
  | 'STALE_MARKET_DATA'
  | 'INVALID_QUANTITY'
  | 'MISSING_STOP_LOSS';

export interface RiskRejection {
  readonly code: RiskRejectionCode;
  readonly detail: string;
}

/**
 * Outcome of a risk evaluation.
 *
 * `approvedQuantity` may be smaller than requested: controls that are about
 * size (exposure, concentration, capital) scale an order down rather than
 * reject it outright. Controls that are about state (kill switch, drawdown,
 * breakers) always reject — trading less is not a safe response to "the system
 * should not be trading at all".
 */
export interface RiskDecision {
  readonly approved: boolean;
  readonly approvedQuantity: number;
  readonly rejections: readonly RiskRejection[];
  /** Controls that reduced the size but did not reject. */
  readonly adjustments: readonly string[];
}

export interface RiskLimits {
  /** Fraction of equity risked on a single trade if its stop is hit. */
  readonly riskPerTradeFraction: number;
  /** Cap on the value of any one position, as a fraction of equity. */
  readonly maxPositionFraction: number;
  /** Cap on total absolute exposure (long + short), as a fraction of equity. */
  readonly maxGrossExposureFraction: number;
  /** Cap on directional exposure (long - short), as a fraction of equity. */
  readonly maxNetExposureFraction: number;
  /** Cap on exposure to one symbol, as a fraction of equity. */
  readonly maxSymbolConcentrationFraction: number;
  /** Loss since start-of-day that halts trading, as a fraction of start-of-day equity. */
  readonly dailyLossLimitFraction: number;
  /** Peak-to-trough equity decline that halts trading, as a fraction of peak. */
  readonly maxDrawdownFraction: number;
  /** Hard cap on simultaneously open positions. */
  readonly maxOpenPositions: number;
  /** Consecutive losing trades that trip the breaker. */
  readonly maxConsecutiveLosses: number;
  /**
   * Cooling-off period after the consecutive-loss breaker trips, in ms.
   *
   * The breaker is a pause, not a latch. Without a reset it would trip once and
   * block every subsequent entry forever — and because a *winning* trade is
   * what clears a losing streak, a system that cannot open a trade can never
   * clear it. The result looks like a running system that has silently stopped
   * trading, which is the worst of both worlds.
   */
  readonly consecutiveLossCooldownMs: number;
  /** Orders per minute above which the breaker trips (runaway-loop guard). */
  readonly maxOrdersPerMinute: number;
  /** Reject entries that carry no protective stop. */
  readonly requireStopLoss: boolean;
}

/**
 * Conservative defaults.
 *
 * Deliberately tighter than most traders would choose: the failure mode of a
 * too-tight limit is a missed trade, and of a too-loose one is an account.
 */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  riskPerTradeFraction: 0.01,
  maxPositionFraction: 0.1,
  maxGrossExposureFraction: 1.0,
  maxNetExposureFraction: 0.75,
  maxSymbolConcentrationFraction: 0.15,
  dailyLossLimitFraction: 0.03,
  maxDrawdownFraction: 0.15,
  maxOpenPositions: 10,
  maxConsecutiveLosses: 4,
  consecutiveLossCooldownMs: 86_400_000, // one day
  maxOrdersPerMinute: 30,
  requireStopLoss: true,
};

/** Everything the risk engine needs to judge an order. Supplied by the portfolio layer. */
export interface AccountState {
  /** Cash + marked-to-market value of open positions. */
  readonly equity: Paise;
  /** Unencumbered cash. */
  readonly availableCash: Paise;
  /** Equity at the first tick of the current session — the daily-loss baseline. */
  readonly startOfDayEquity: Paise;
  /** Highest equity ever reached — the drawdown baseline. */
  readonly peakEquity: Paise;
  readonly positions: readonly Position[];
  /** Realised + unrealised P&L since start of day. */
  readonly dayPnl: Paise;
  readonly consecutiveLosses: number;
  /** Order submission timestamps within the last minute, for the rate breaker. */
  readonly recentOrderTimestamps: readonly Timestamp[];
  /** Capital allocated per strategy; absent means unlimited. */
  readonly strategyAllocations?: Readonly<Record<string, Paise>>;
  /** Exposure already taken by each strategy. */
  readonly strategyExposure?: Readonly<Record<string, Paise>>;
}

/** An order the risk engine is asked to judge, with the context to judge it. */
export interface RiskContext {
  readonly request: OrderRequest;
  /** Price used to value the order — last trade or the limit price. */
  readonly referencePrice: Paise;
  /** Protective stop, if the strategy set one. */
  readonly stopLoss?: Paise;
  readonly now: Timestamp;
  readonly marketOpen: boolean;
  readonly dataIsStale: boolean;
}
