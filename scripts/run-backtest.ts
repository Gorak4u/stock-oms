/**
 * Runnable demonstration of the full workflow.
 *
 * Generates a deterministic synthetic series (no `Math.random`, so the output
 * is reproducible), runs every bundled strategy over it, and prints the
 * metrics — then walk-forward validates the trend-following strategy.
 *
 * The numbers below are meaningless as evidence about real markets: synthetic
 * data has none of the structure a strategy is trying to exploit. It exists to
 * show the machinery working end to end.
 *
 *   npm run backtest
 */

import { format, fromRupees } from '../src/domain/money';
import type { Candle } from '../src/domain/types';
import { BacktestEngine } from '../src/backtest/engine';
import { walkForward } from '../src/backtest/walkForward';
import { DEFAULT_RISK_LIMITS } from '../src/risk/types';
import { TrendFollowingStrategy } from '../src/strategy/trendFollowing';
import { MeanReversionStrategy } from '../src/strategy/meanReversion';
import { MomentumStrategy } from '../src/strategy/momentum';
import { VolatilityBreakoutStrategy } from '../src/strategy/volatility';
import type { Strategy } from '../src/strategy/types';
import type { PerformanceMetrics } from '../src/backtest/metrics';

const DAY = 86_400_000;
const START = Date.parse('2021-01-01T00:00:00Z');

function syntheticSeries(length: number, seed = 42): Candle[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  const candles: Candle[] = [];
  let price = 1500;
  // A slow regime cycle so trend and mean-reversion strategies both see
  // conditions they are built for.
  for (let i = 0; i < length; i += 1) {
    const regime = Math.sin(i / 120) * 0.0012;
    const shock = (next() - 0.5) * 0.025 + regime;
    const open = price;
    const close = Math.max(1, open * (1 + shock));
    const high = Math.max(open, close) * (1 + next() * 0.008);
    const low = Math.min(open, close) * (1 - next() * 0.008);

    candles.push({
      symbol: 'NSE:SYNTH',
      interval: '1d',
      timestamp: START + i * DAY,
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

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function reportRow(name: string, metrics: PerformanceMetrics): string {
  return [
    name.padEnd(22),
    pct(metrics.totalReturn).padStart(9),
    pct(metrics.cagr).padStart(9),
    metrics.sharpe.toFixed(2).padStart(7),
    pct(metrics.drawdown.maxDrawdown).padStart(9),
    String(metrics.tradeCount).padStart(7),
    pct(metrics.winRate).padStart(8),
    (Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞').padStart(7),
  ].join(' ');
}

async function main(): Promise<void> {
  const candles = syntheticSeries(1250); // ~5 years of sessions
  const openingCash = fromRupees(1_000_000);

  console.log('AI Trading Platform — backtest demonstration');
  console.log(`Synthetic series: ${candles.length} daily bars, opening capital ${format(openingCash)}`);
  console.log('NOTE: synthetic data. These numbers say nothing about real markets.\n');

  const strategies: [string, Strategy<unknown>][] = [
    ['Trend following', new TrendFollowingStrategy()],
    ['Mean reversion', new MeanReversionStrategy()],
    ['Momentum', new MomentumStrategy()],
    ['Volatility breakout', new VolatilityBreakoutStrategy()],
  ];

  console.log(
    ['Strategy'.padEnd(22), 'Return'.padStart(9), 'CAGR'.padStart(9), 'Sharpe'.padStart(7),
     'MaxDD'.padStart(9), 'Trades'.padStart(7), 'Win%'.padStart(8), 'PF'.padStart(7)].join(' '),
  );
  console.log('-'.repeat(82));

  for (const [name, strategy] of strategies) {
    const engine = new BacktestEngine({
      openingCash,
      limits: DEFAULT_RISK_LIMITS,
      useTrailingStops: true,
    });

    const result = await engine.run(strategy, candles);
    console.log(reportRow(name, result.metrics));

    if (result.riskRejections.length > 0 || result.modelVetoes.length > 0) {
      console.log(
        `${' '.repeat(22)} (${result.signals.length} signals, ` +
          `${result.riskRejections.length} risk-rejected, ` +
          `${result.modelVetoes.length} model-vetoed)`,
      );
    }
  }

  console.log('\nWalk-forward validation — trend following');
  console.log('-'.repeat(82));

  const report = await walkForward(
    candles,
    [
      { fastPeriod: 10, slowPeriod: 30 },
      { fastPeriod: 20, slowPeriod: 50 },
      { fastPeriod: 30, slowPeriod: 90 },
    ],
    (params) => new TrendFollowingStrategy(params),
    {
      openingCash,
      limits: DEFAULT_RISK_LIMITS,
      trainBars: 400,
      testBars: 150,
      objective: (metrics) => metrics.sharpe,
    },
  );

  for (const [index, fold] of report.folds.entries()) {
    const params = fold.selectedParams as { fastPeriod: number; slowPeriod: number };
    console.log(
      `  fold ${index + 1}: EMA ${params.fastPeriod}/${params.slowPeriod} — ` +
        `in-sample ${pct(fold.trainMetrics.totalReturn)}, ` +
        `out-of-sample ${pct(fold.testMetrics.totalReturn)}`,
    );
  }

  console.log(`\n  Aggregate out-of-sample return: ${pct(report.aggregate.totalReturn)}`);
  console.log(`  Walk-forward efficiency:        ${report.efficiency.toFixed(2)}`);
  console.log(
    '  (near 1 means the edge survived out of sample; well below 1 means the\n' +
      '   parameters were fitted to noise and the strategy should not be traded)',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
