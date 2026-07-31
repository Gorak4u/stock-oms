/**
 * Browser entry point.
 *
 * Exposes the real engine to a page so a backtest can be driven interactively.
 * The core is pure computation with no I/O, so exactly the same strategy, risk,
 * sizing, cost and fill code that runs under Node runs here — this is a front
 * end onto the platform, not a reimplementation of it.
 */

import { format, fromRupees, toRupees, type Paise } from './domain/money';
import type { Candle } from './domain/types';
import { BacktestEngine } from './backtest/engine';
import { walkForward } from './backtest/walkForward';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from './risk/types';
import { DEFAULT_COST_SCHEDULE, ZERO_COST_SCHEDULE } from './execution/costs';
import { TrendFollowingStrategy } from './strategy/trendFollowing';
import { MeanReversionStrategy } from './strategy/meanReversion';
import { MomentumStrategy } from './strategy/momentum';
import { VolatilityBreakoutStrategy } from './strategy/volatility';
import type { Strategy } from './strategy/types';
import { validateCandle } from './marketdata/validation';

const DAY = 86_400_000;

export type StrategyKey = 'trend' | 'meanReversion' | 'momentum' | 'volatility';

export const STRATEGY_LABELS: Record<StrategyKey, string> = {
  trend: 'Trend following',
  meanReversion: 'Mean reversion',
  momentum: 'Momentum',
  volatility: 'Volatility breakout',
};

function buildStrategy(key: StrategyKey, params: Record<string, number>): Strategy<unknown> {
  switch (key) {
    case 'trend':
      return new TrendFollowingStrategy({
        ...(params.fastPeriod ? { fastPeriod: params.fastPeriod } : {}),
        ...(params.slowPeriod ? { slowPeriod: params.slowPeriod } : {}),
        ...(params.atrStopMultiplier ? { atrStopMultiplier: params.atrStopMultiplier } : {}),
      });
    case 'meanReversion':
      return new MeanReversionStrategy({
        ...(params.lookback ? { lookback: params.lookback } : {}),
        ...(params.entryZ ? { entryZ: params.entryZ } : {}),
      });
    case 'momentum':
      return new MomentumStrategy({
        ...(params.channelPeriod ? { channelPeriod: params.channelPeriod } : {}),
        ...(params.exitChannelPeriod ? { exitChannelPeriod: params.exitChannelPeriod } : {}),
      });
    case 'volatility':
      return new VolatilityBreakoutStrategy({
        ...(params.bandPeriod ? { bandPeriod: params.bandPeriod } : {}),
        ...(params.squeezeLookback ? { squeezeLookback: params.squeezeLookback } : {}),
      });
  }
}

/**
 * Deterministic synthetic series.
 *
 * A seeded LCG, not `Math.random`, so the same seed always reproduces the same
 * series — otherwise nothing shown here could be checked against a rerun.
 */
export function syntheticSeries(
  length: number,
  seed: number,
  options: { startPrice?: number; volatility?: number; regimeStrength?: number } = {},
): Candle[] {
  const startPrice = options.startPrice ?? 1500;
  const volatility = options.volatility ?? 0.025;
  const regimeStrength = options.regimeStrength ?? 0.0012;

  let state = Math.abs(Math.trunc(seed)) % 2147483647 || 42;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  const start = Date.parse('2021-01-01T00:00:00Z');
  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < length; i += 1) {
    const regime = Math.sin(i / 120) * regimeStrength;
    const shock = (next() - 0.5) * volatility + regime;
    const open = price;
    const close = Math.max(1, open * (1 + shock));
    const high = Math.max(open, close) * (1 + next() * 0.008);
    const low = Math.min(open, close) * (1 - next() * 0.008);

    candles.push({
      symbol: 'SYNTH',
      interval: '1d',
      timestamp: start + i * DAY,
      open: fromRupees(open),
      high: fromRupees(high),
      low: fromRupees(low),
      close: fromRupees(close),
      volume: 250_000 + Math.floor(next() * 100_000),
    });

    price = close;
  }

  return candles;
}

export interface ParsedCsv {
  readonly candles: Candle[];
  readonly skipped: number;
  readonly errors: string[];
}

/**
 * Parses OHLC CSV.
 *
 * Accepts a header row naming the columns in any order; `date`/`timestamp`,
 * `open`, `high`, `low`, `close` are required and `volume` is optional. Rows
 * that fail candle validation are counted and reported rather than silently
 * dropped — bad reference data is the most common cause of a backtest that
 * cannot be reproduced.
 */
export function parseCsv(text: string, symbol = 'IMPORTED'): ParsedCsv {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { candles: [], skipped: 0, errors: ['Need a header row and at least one data row.'] };
  }

  const header = lines[0]!.split(',').map((cell) => cell.trim().toLowerCase());
  const indexOf = (...names: string[]): number => {
    for (const name of names) {
      const found = header.indexOf(name);
      if (found >= 0) return found;
    }
    return -1;
  };

  const dateAt = indexOf('date', 'timestamp', 'time', 'datetime');
  const openAt = indexOf('open', 'o');
  const highAt = indexOf('high', 'h');
  const lowAt = indexOf('low', 'l');
  const closeAt = indexOf('close', 'c', 'adj close');
  const volumeAt = indexOf('volume', 'v', 'vol');

  const missing: string[] = [];
  if (dateAt < 0) missing.push('date');
  if (openAt < 0) missing.push('open');
  if (highAt < 0) missing.push('high');
  if (lowAt < 0) missing.push('low');
  if (closeAt < 0) missing.push('close');
  if (missing.length > 0) {
    return { candles: [], skipped: 0, errors: [`Missing column(s): ${missing.join(', ')}.`] };
  }

  const candles: Candle[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',');
    const rawDate = (cells[dateAt] ?? '').trim();
    const timestamp = Date.parse(rawDate.length === 10 ? `${rawDate}T00:00:00Z` : rawDate);

    const open = Number(cells[openAt]);
    const high = Number(cells[highAt]);
    const low = Number(cells[lowAt]);
    const close = Number(cells[closeAt]);
    const volume = volumeAt >= 0 ? Number(cells[volumeAt]) : 0;

    if (
      Number.isNaN(timestamp) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      skipped += 1;
      if (errors.length < 5) errors.push(`Row ${i + 1}: could not parse date or prices.`);
      continue;
    }

    const candle: Candle = {
      symbol,
      interval: '1d',
      timestamp,
      open: fromRupees(open),
      high: fromRupees(high),
      low: fromRupees(low),
      close: fromRupees(close),
      volume: Number.isFinite(volume) ? volume : 0,
    };

    const validation = validateCandle(candle);
    if (!validation.valid) {
      skipped += 1;
      if (errors.length < 5) {
        errors.push(`Row ${i + 1}: ${validation.rejections.map((r) => r.code).join(', ')}.`);
      }
      continue;
    }

    candles.push(candle);
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  return { candles, skipped, errors };
}

export interface RunRequest {
  readonly strategy: StrategyKey;
  readonly params: Record<string, number>;
  readonly candles: Candle[];
  readonly openingCash: number;
  readonly limits: Partial<RiskLimits>;
  readonly applyCosts: boolean;
  readonly slippageFraction: number;
  readonly trailingStops: boolean;
}

export interface RunSummary {
  readonly totalReturn: number;
  readonly cagr: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownAmount: string;
  readonly tradeCount: number;
  readonly winRate: number;
  readonly profitFactor: number;
  readonly expectancy: string;
  readonly openingEquity: string;
  readonly closingEquity: string;
  readonly maxConsecutiveLosses: number;
  readonly exposureFraction: number;
  readonly largestWin: string;
  readonly largestLoss: string;
}

export interface RunResult {
  readonly summary: RunSummary;
  /** Equity in rupees, for plotting. */
  readonly curve: { t: number; equity: number }[];
  readonly priceCurve: { t: number; close: number }[];
  readonly trades: {
    symbol: string;
    direction: string;
    quantity: number;
    entry: string;
    exit: string;
    pnl: string;
    pnlValue: number;
    closedAt: number;
  }[];
  readonly signalCount: number;
  readonly rejections: { reason: string; count: number }[];
  readonly auditEvents: { type: string; count: number }[];
  readonly auditIntact: boolean;
}

export async function runBacktest(request: RunRequest): Promise<RunResult> {
  const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS, ...request.limits };

  const engine = new BacktestEngine({
    openingCash: fromRupees(request.openingCash),
    limits,
    costSchedule: request.applyCosts ? DEFAULT_COST_SCHEDULE : ZERO_COST_SCHEDULE,
    slippageFraction: request.slippageFraction,
    useTrailingStops: request.trailingStops,
  });

  const result = await engine.run(buildStrategy(request.strategy, request.params), request.candles);
  const m = result.metrics;

  const rejectionCounts = new Map<string, number>();
  for (const rejection of result.riskRejections) {
    for (const reason of rejection.reasons) {
      const code = reason.split(':')[0]!.trim();
      rejectionCounts.set(code, (rejectionCounts.get(code) ?? 0) + 1);
    }
  }

  const auditCounts = new Map<string, number>();
  for (const record of result.audit.all()) {
    auditCounts.set(record.type, (auditCounts.get(record.type) ?? 0) + 1);
  }

  return {
    summary: {
      totalReturn: m.totalReturn,
      cagr: m.cagr,
      sharpe: m.sharpe,
      sortino: Number.isFinite(m.sortino) ? m.sortino : 0,
      maxDrawdown: m.drawdown.maxDrawdown,
      maxDrawdownAmount: format(m.drawdown.maxDrawdownAmount),
      tradeCount: m.tradeCount,
      winRate: m.winRate,
      profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : 0,
      expectancy: format(m.expectancy),
      openingEquity: format(m.openingEquity),
      closingEquity: format(m.closingEquity),
      maxConsecutiveLosses: m.maxConsecutiveLosses,
      exposureFraction: m.exposureFraction,
      largestWin: format(m.largestWin),
      largestLoss: format(m.largestLoss),
    },
    curve: result.curve.map((point) => ({ t: point.timestamp, equity: toRupees(point.equity) })),
    priceCurve: request.candles.map((candle) => ({
      t: candle.timestamp,
      close: toRupees(candle.close),
    })),
    trades: result.trades.map((trade) => ({
      symbol: trade.symbol,
      direction: trade.direction,
      quantity: trade.quantity,
      entry: format(trade.entryPrice),
      exit: format(trade.exitPrice),
      pnl: format(trade.pnl),
      pnlValue: toRupees(trade.pnl),
      closedAt: trade.closedAt,
    })),
    signalCount: result.signals.length,
    rejections: [...rejectionCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    auditEvents: [...auditCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    auditIntact: result.audit.verifyChain() === null,
  };
}

export interface WalkForwardResult {
  readonly folds: {
    fold: number;
    params: string;
    inSample: number;
    outOfSample: number;
  }[];
  readonly aggregateReturn: number;
  readonly aggregateSharpe: number;
  readonly efficiency: number;
}

export async function runWalkForward(
  request: RunRequest,
  trainBars: number,
  testBars: number,
): Promise<WalkForwardResult> {
  const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS, ...request.limits };

  const grids: Record<StrategyKey, Record<string, number>[]> = {
    trend: [
      { fastPeriod: 10, slowPeriod: 30 },
      { fastPeriod: 20, slowPeriod: 50 },
      { fastPeriod: 30, slowPeriod: 90 },
    ],
    meanReversion: [
      { lookback: 15, entryZ: 1.5 },
      { lookback: 20, entryZ: 2 },
      { lookback: 30, entryZ: 2.5 },
    ],
    momentum: [
      { channelPeriod: 40, exitChannelPeriod: 15 },
      { channelPeriod: 55, exitChannelPeriod: 20 },
      { channelPeriod: 80, exitChannelPeriod: 30 },
    ],
    volatility: [
      { bandPeriod: 15, squeezeLookback: 80 },
      { bandPeriod: 20, squeezeLookback: 100 },
      { bandPeriod: 25, squeezeLookback: 120 },
    ],
  };

  const report = await walkForward(
    request.candles,
    grids[request.strategy],
    (params) => buildStrategy(request.strategy, params),
    {
      openingCash: fromRupees(request.openingCash),
      limits,
      costSchedule: request.applyCosts ? DEFAULT_COST_SCHEDULE : ZERO_COST_SCHEDULE,
      slippageFraction: request.slippageFraction,
      useTrailingStops: request.trailingStops,
      trainBars,
      testBars,
      objective: (metrics) => metrics.sharpe,
    },
  );

  return {
    folds: report.folds.map((fold, index) => ({
      fold: index + 1,
      params: Object.entries(fold.selectedParams as Record<string, number>)
        .map(([key, value]) => `${key}=${value}`)
        .join(' '),
      inSample: fold.trainMetrics.totalReturn,
      outOfSample: fold.testMetrics.totalReturn,
    })),
    aggregateReturn: report.aggregate.totalReturn,
    aggregateSharpe: report.aggregate.sharpe,
    efficiency: report.efficiency,
  };
}

export { format, fromRupees, toRupees, DEFAULT_RISK_LIMITS };
export type { Paise, RiskLimits, Candle };
