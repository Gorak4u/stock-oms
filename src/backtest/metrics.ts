/**
 * Performance metrics.
 *
 * Total return alone hides everything that decides whether a strategy is
 * survivable: how deep the drawdowns were, how much of the return was one
 * lucky trade, and whether the losses cluster. These are the numbers that
 * decide whether a strategy graduates from backtest to paper to live.
 */

import { ratio, type Paise } from '../domain/money';
import type { Timestamp } from '../domain/types';
import type { ClosedTrade } from '../execution/portfolio';

export interface EquityPoint {
  readonly timestamp: Timestamp;
  readonly equity: Paise;
}

export interface DrawdownInfo {
  /** Deepest peak-to-trough decline, as a positive fraction. */
  readonly maxDrawdown: number;
  readonly maxDrawdownAmount: Paise;
  readonly peakAt: Timestamp;
  readonly troughAt: Timestamp;
  /** Bars from the peak until equity recovered; `null` if never recovered. */
  readonly recoveryBars: number | null;
  /** Longest stretch below a prior peak, in bars. */
  readonly longestUnderwaterBars: number;
}

export interface PerformanceMetrics {
  readonly openingEquity: Paise;
  readonly closingEquity: Paise;
  readonly totalReturn: number;
  readonly cagr: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly calmar: number;
  readonly drawdown: DrawdownInfo;
  readonly tradeCount: number;
  readonly winRate: number;
  /** Gross profit ÷ gross loss. Above 1 means the wins outweigh the losses. */
  readonly profitFactor: number;
  readonly averageWin: Paise;
  readonly averageLoss: Paise;
  /** Expected P&L per trade — the number that decides long-run viability. */
  readonly expectancy: Paise;
  readonly largestWin: Paise;
  readonly largestLoss: Paise;
  readonly maxConsecutiveLosses: number;
  readonly exposureFraction: number;
}

const TRADING_DAYS_PER_YEAR = 252;

/** Bar-over-bar simple returns from an equity curve. */
export function equityReturns(curve: readonly EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const previous = curve[i - 1]!.equity;
    if (previous === 0) {
      returns.push(0);
      continue;
    }
    returns.push((curve[i]!.equity - previous) / previous);
  }
  return returns;
}

export function computeDrawdown(curve: readonly EquityPoint[]): DrawdownInfo {
  if (curve.length === 0) {
    return {
      maxDrawdown: 0,
      maxDrawdownAmount: 0 as Paise,
      peakAt: 0,
      troughAt: 0,
      recoveryBars: null,
      longestUnderwaterBars: 0,
    };
  }

  let peak = curve[0]!.equity;
  let peakAt = curve[0]!.timestamp;
  let peakIndex = 0;

  let maxDrawdown = 0;
  let maxDrawdownAmount = 0 as Paise;
  let worstPeakAt = peakAt;
  let worstTroughAt = peakAt;
  let worstPeakIndex = 0;
  let worstTroughIndex = 0;

  let underwaterStart: number | null = null;
  let longestUnderwaterBars = 0;

  for (let i = 0; i < curve.length; i += 1) {
    const point = curve[i]!;

    if (point.equity >= peak) {
      peak = point.equity;
      peakAt = point.timestamp;
      peakIndex = i;

      if (underwaterStart !== null) {
        longestUnderwaterBars = Math.max(longestUnderwaterBars, i - underwaterStart);
        underwaterStart = null;
      }
      continue;
    }

    if (underwaterStart === null) underwaterStart = peakIndex;

    const decline = peak === 0 ? 0 : (peak - point.equity) / peak;
    if (decline > maxDrawdown) {
      maxDrawdown = decline;
      maxDrawdownAmount = (peak - point.equity) as Paise;
      worstPeakAt = peakAt;
      worstTroughAt = point.timestamp;
      worstPeakIndex = peakIndex;
      worstTroughIndex = i;
    }
  }

  if (underwaterStart !== null) {
    longestUnderwaterBars = Math.max(longestUnderwaterBars, curve.length - 1 - underwaterStart);
  }

  // Recovery is measured from the worst peak, not the trough: the position was
  // only whole again once equity regained the level it fell from.
  let recoveryBars: number | null = null;
  const peakEquity = curve[worstPeakIndex]!.equity;
  for (let i = worstTroughIndex; i < curve.length; i += 1) {
    if (curve[i]!.equity >= peakEquity) {
      recoveryBars = i - worstPeakIndex;
      break;
    }
  }

  return {
    maxDrawdown,
    maxDrawdownAmount,
    peakAt: worstPeakAt,
    troughAt: worstTroughAt,
    recoveryBars,
    longestUnderwaterBars,
  };
}

/**
 * Annualised Sharpe ratio.
 *
 * Zero when returns are constant — a flat curve has no risk-adjusted return to
 * report, and dividing by a zero standard deviation would produce Infinity and
 * quietly rank a do-nothing strategy best.
 */
export function sharpeRatio(
  returns: readonly number[],
  riskFreeRate = 0,
  periodsPerYear = TRADING_DAYS_PER_YEAR,
): number {
  if (returns.length < 2) return 0;

  const periodRiskFree = riskFreeRate / periodsPerYear;
  const excess = returns.map((value) => value - periodRiskFree);
  const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length;

  const variance =
    excess.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (excess.length - 1);
  const deviation = Math.sqrt(variance);
  if (deviation === 0) return 0;

  return (mean / deviation) * Math.sqrt(periodsPerYear);
}

/**
 * Sortino ratio — Sharpe, but penalising only downside deviation.
 *
 * Upside volatility is not a risk anyone needs protecting from; Sharpe
 * punishes a strategy for having unusually good months.
 */
export function sortinoRatio(
  returns: readonly number[],
  riskFreeRate = 0,
  periodsPerYear = TRADING_DAYS_PER_YEAR,
): number {
  if (returns.length < 2) return 0;

  const periodRiskFree = riskFreeRate / periodsPerYear;
  const excess = returns.map((value) => value - periodRiskFree);
  const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length;

  const downside = excess.filter((value) => value < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;

  const downsideVariance =
    downside.reduce((sum, value) => sum + value * value, 0) / excess.length;
  const downsideDeviation = Math.sqrt(downsideVariance);
  if (downsideDeviation === 0) return 0;

  return (mean / downsideDeviation) * Math.sqrt(periodsPerYear);
}

export interface MetricsInput {
  readonly curve: readonly EquityPoint[];
  readonly trades: readonly ClosedTrade[];
  readonly riskFreeRate?: number;
  readonly periodsPerYear?: number;
  /** Bars during which at least one position was open, for exposure. */
  readonly barsInMarket?: number;
}

export function computeMetrics(input: MetricsInput): PerformanceMetrics {
  const { curve, trades } = input;
  const periodsPerYear = input.periodsPerYear ?? TRADING_DAYS_PER_YEAR;
  const riskFreeRate = input.riskFreeRate ?? 0;

  const openingEquity = curve[0]?.equity ?? (0 as Paise);
  const closingEquity = curve[curve.length - 1]?.equity ?? openingEquity;

  const totalReturn = openingEquity === 0 ? 0 : ratio(closingEquity, openingEquity) - 1;

  const years = curve.length > 1 ? (curve.length - 1) / periodsPerYear : 0;
  // CAGR is undefined once equity hits zero — a wiped-out account is reported
  // as -100%, not as a complex number.
  const cagr =
    years <= 0 || openingEquity <= 0
      ? 0
      : closingEquity <= 0
        ? -1
        : (closingEquity / openingEquity) ** (1 / years) - 1;

  const returns = equityReturns(curve);
  const drawdown = computeDrawdown(curve);

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);

  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));

  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of trades) {
    if (trade.pnl < 0) {
      consecutiveLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }

  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);

  return {
    openingEquity,
    closingEquity,
    totalReturn,
    cagr,
    sharpe: sharpeRatio(returns, riskFreeRate, periodsPerYear),
    sortino: sortinoRatio(returns, riskFreeRate, periodsPerYear),
    calmar: drawdown.maxDrawdown === 0 ? 0 : cagr / drawdown.maxDrawdown,
    drawdown,
    tradeCount: trades.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    averageWin: (wins.length === 0 ? 0 : Math.round(grossProfit / wins.length)) as Paise,
    averageLoss: (losses.length === 0 ? 0 : Math.round(grossLoss / losses.length)) as Paise,
    expectancy: (trades.length === 0 ? 0 : Math.round(netPnl / trades.length)) as Paise,
    largestWin: (wins.length === 0 ? 0 : Math.max(...wins.map((t) => t.pnl))) as Paise,
    largestLoss: (losses.length === 0 ? 0 : Math.min(...losses.map((t) => t.pnl))) as Paise,
    maxConsecutiveLosses,
    exposureFraction:
      input.barsInMarket === undefined || curve.length === 0
        ? 0
        : input.barsInMarket / curve.length,
  };
}
