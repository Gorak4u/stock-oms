/**
 * Walk-forward validation.
 *
 * A single backtest over the whole history tells you almost nothing once
 * parameters have been tuned on that same history — with enough parameters,
 * any series can be fitted. Walk-forward answers the question that actually
 * matters: *would parameters chosen using only past data have worked on the
 * data that came next?*
 *
 * The procedure is a rolling pair of windows:
 *
 *   [-- train --][ test ]
 *          [-- train --][ test ]
 *                 [-- train --][ test ]
 *
 * Parameters are selected on each train window and evaluated, untouched, on
 * the test window that follows it. Only the concatenated test results are
 * reported — the train results are selection noise, not performance.
 *
 * A strategy whose walk-forward efficiency is far below 1 was fitted to its
 * training data and should not be traded.
 */

import type { Candle } from '../domain/types';
import type { Strategy } from '../strategy/types';
import { BacktestEngine, type BacktestConfig, type BacktestResult } from './engine';
import { computeMetrics, type EquityPoint, type PerformanceMetrics } from './metrics';
import type { ClosedTrade } from '../execution/portfolio';

export interface WalkForwardWindow {
  readonly trainStart: number;
  readonly trainEnd: number;
  readonly testStart: number;
  readonly testEnd: number;
}

export interface WalkForwardConfig extends BacktestConfig {
  /** Bars per training window. */
  readonly trainBars: number;
  /** Bars per test window; also the step between windows. */
  readonly testBars: number;
  /** Metric used to pick parameters on the train window. */
  readonly objective?: (metrics: PerformanceMetrics) => number;
}

export interface WalkForwardFold<Params> {
  readonly window: WalkForwardWindow;
  readonly selectedParams: Params;
  readonly trainMetrics: PerformanceMetrics;
  readonly testMetrics: PerformanceMetrics;
}

export interface WalkForwardReport<Params> {
  readonly folds: readonly WalkForwardFold<Params>[];
  /** Metrics over the concatenated out-of-sample windows — the honest number. */
  readonly aggregate: PerformanceMetrics;
  /**
   * Out-of-sample performance ÷ in-sample performance.
   *
   * Around 1 means the edge survived. Well below 1 means the parameters were
   * fitted. Above 1 is usually luck, not skill.
   */
  readonly efficiency: number;
}

/** Default objective: risk-adjusted return, penalising drawdown. */
export function defaultObjective(metrics: PerformanceMetrics): number {
  if (metrics.tradeCount < 5) return -Infinity;
  return metrics.sharpe;
}

export function buildWindows(
  totalBars: number,
  trainBars: number,
  testBars: number,
): WalkForwardWindow[] {
  if (trainBars < 1 || testBars < 1) throw new Error('window sizes must be positive');

  const windows: WalkForwardWindow[] = [];
  let trainStart = 0;

  while (trainStart + trainBars + testBars <= totalBars) {
    const trainEnd = trainStart + trainBars;
    windows.push({
      trainStart,
      trainEnd,
      testStart: trainEnd,
      testEnd: Math.min(trainEnd + testBars, totalBars),
    });
    trainStart += testBars;
  }

  return windows;
}

/**
 * Runs walk-forward validation over a parameter grid.
 *
 * `buildStrategy` turns one parameter set into a strategy instance. The grid is
 * searched exhaustively on each train window — fine for the handful of
 * parameters these strategies expose, and far more predictable than a
 * stochastic search when results have to be reproducible.
 */
export async function walkForward<Params>(
  candles: readonly Candle[],
  grid: readonly Params[],
  buildStrategy: (params: Params) => Strategy<unknown>,
  config: WalkForwardConfig,
): Promise<WalkForwardReport<Params>> {
  if (grid.length === 0) throw new Error('parameter grid is empty');

  const objective = config.objective ?? defaultObjective;
  const windows = buildWindows(candles.length, config.trainBars, config.testBars);

  if (windows.length === 0) {
    throw new Error(
      `series of ${candles.length} bars is too short for ${config.trainBars}+${config.testBars} windows`,
    );
  }

  const folds: WalkForwardFold<Params>[] = [];
  const combinedCurve: EquityPoint[] = [];
  const combinedTrades: ClosedTrade[] = [];
  let inSampleTotal = 0;
  let outOfSampleTotal = 0;

  for (const window of windows) {
    const trainSlice = candles.slice(window.trainStart, window.trainEnd);
    const testSlice = candles.slice(window.testStart, window.testEnd);

    // --- Select parameters using train data only. --------------------------
    let bestParams: Params | null = null;
    let bestScore = -Infinity;
    let bestTrainResult: BacktestResult | null = null;

    for (const params of grid) {
      const engine = new BacktestEngine(config);
      const result = await engine.run(buildStrategy(params), trainSlice);
      const score = objective(result.metrics);

      if (score > bestScore) {
        bestScore = score;
        bestParams = params;
        bestTrainResult = result;
      }
    }

    // Every candidate failed the objective's minimum bar (too few trades, say).
    // Skipping the fold is more honest than trading parameters nothing endorsed.
    if (bestParams === null || bestTrainResult === null || bestScore === -Infinity) continue;

    // --- Evaluate the chosen parameters on unseen data. --------------------
    const testEngine = new BacktestEngine(config);
    const testResult = await testEngine.run(buildStrategy(bestParams), testSlice);

    folds.push({
      window,
      selectedParams: bestParams,
      trainMetrics: bestTrainResult.metrics,
      testMetrics: testResult.metrics,
    });

    combinedCurve.push(...testResult.curve);
    combinedTrades.push(...testResult.trades);
    inSampleTotal += bestTrainResult.metrics.totalReturn;
    outOfSampleTotal += testResult.metrics.totalReturn;
  }

  if (folds.length === 0) {
    throw new Error('no fold produced a usable parameter set — widen the grid or lengthen windows');
  }

  const aggregate = computeMetrics({
    curve: combinedCurve,
    trades: combinedTrades,
    ...(config.periodsPerYear !== undefined ? { periodsPerYear: config.periodsPerYear } : {}),
  });

  const efficiency =
    inSampleTotal === 0 ? 0 : outOfSampleTotal / Math.abs(inSampleTotal) * Math.sign(inSampleTotal);

  return { folds, aggregate, efficiency };
}
