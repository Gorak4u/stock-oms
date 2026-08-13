/**
 * Backtests the bundled strategies over real market data.
 *
 * Two sources, because there are two situations you run this in:
 *
 *   npm run backtest -- --symbol NSE:RELIANCE --from 2024-01-01 --to 2025-12-31
 *   npm run backtest -- --csv ./data/reliance-daily.csv
 *
 * The first reads the `candle` table this platform ingests into, so it measures
 * strategies against exactly the bars the live loop would have traded on. The
 * second takes an OHLC export, for data the platform has not ingested.
 *
 * There is deliberately no generated-series mode. A random walk has none of the
 * structure a strategy exists to exploit, so a number produced from one is not a
 * weak result — it is not a result at all, and printing it next to real metrics
 * in the same table invites exactly the confusion this tool should prevent.
 */

import { readFileSync } from 'node:fs';
import { format, fromRupees } from '../src/domain/money';
import type { Candle, Interval } from '../src/domain/types';
import { BacktestEngine } from '../src/backtest/engine';
import { walkForward } from '../src/backtest/walkForward';
import { DEFAULT_RISK_LIMITS } from '../src/risk/types';
import { TrendFollowingStrategy } from '../src/strategy/trendFollowing';
import { MeanReversionStrategy } from '../src/strategy/meanReversion';
import { MomentumStrategy } from '../src/strategy/momentum';
import { VolatilityBreakoutStrategy } from '../src/strategy/volatility';
import type { Strategy } from '../src/strategy/types';
import type { PerformanceMetrics } from '../src/backtest/metrics';
import { Database, databaseOptionsFromEnv } from '../src/persistence/postgres';
import { parseCsv } from '../src/browser';

/** Enough bars to warm the slowest indicator and still leave something to measure. */
const MIN_BARS = 120;

interface Options {
  csv: string | null;
  symbol: string | null;
  interval: Interval;
  from: string;
  to: string;
  capital: number;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Usage: npm run backtest -- [options]

  --symbol SYM      Symbol to read from the candle table, e.g. NSE:RELIANCE
  --interval I      Bar size to read (default: 1d)
  --from DATE       Inclusive start, YYYY-MM-DD (default: 2000-01-01)
  --to DATE         Inclusive end, YYYY-MM-DD (default: today)
  --csv PATH        Backtest an OHLC CSV export instead of the database
  --capital N       Opening capital in rupees (default: 1000000)

Supply exactly one of --symbol or --csv.
Environment: DATABASE_URL (required for --symbol)`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    csv: null,
    symbol: null,
    interval: '1d',
    from: '2000-01-01',
    to: new Date().toISOString().slice(0, 10),
    capital: 1_000_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value && flag !== undefined) usage(`${flag} needs a value`);

    switch (flag) {
      case '--csv': options.csv = value!; i += 1; break;
      case '--symbol': options.symbol = value!; i += 1; break;
      case '--interval': options.interval = value! as Interval; i += 1; break;
      case '--from': options.from = value!; i += 1; break;
      case '--to': options.to = value!; i += 1; break;
      case '--capital': options.capital = Number(value); i += 1; break;
      default: usage(`unknown option ${flag}`);
    }
  }

  if (options.csv && options.symbol) usage('--csv and --symbol are mutually exclusive');
  if (!options.csv && !options.symbol) usage('supply --symbol or --csv');
  if (!Number.isFinite(options.capital) || options.capital <= 0) {
    usage('--capital must be a positive number');
  }

  return options;
}

function isoToTimestamp(date: string, endOfDay = false): number {
  const parsed = Date.parse(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(parsed)) usage(`invalid date: ${date} (expected YYYY-MM-DD)`);
  return parsed;
}

/** Reads bars from the platform's own candle table. */
async function loadFromDatabase(options: Options): Promise<{ candles: Candle[]; source: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) usage('DATABASE_URL is required when reading with --symbol');

  const database = new Database(url, databaseOptionsFromEnv());
  try {
    const candles = await database.repositories().candles.range(
      options.symbol!,
      options.interval,
      isoToTimestamp(options.from),
      isoToTimestamp(options.to, true),
    );
    return {
      candles,
      source: `${options.symbol} ${options.interval} from the candle table, ${options.from} to ${options.to}`,
    };
  } finally {
    await database.close();
  }
}

/**
 * Reads bars from a CSV export.
 *
 * Rejected rows are reported rather than dropped: a file that silently lost a
 * tenth of its bars produces a plausible-looking metric measured over data the
 * operator did not think they were testing.
 */
function loadFromCsv(options: Options): { candles: Candle[]; source: string } {
  const text = readFileSync(options.csv!, 'utf8');
  const parsed = parseCsv(text, options.csv!);

  if (parsed.errors.length > 0) {
    console.error(`CSV problems: ${parsed.errors.join(' ')}`);
  }
  if (parsed.skipped > 0) {
    console.error(`${parsed.skipped} row(s) rejected by candle validation.`);
  }

  return {
    candles: parsed.candles,
    source: `${parsed.candles.length} bars from ${options.csv}`,
  };
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
  const options = parseArgs(process.argv.slice(2));
  const { candles, source } = options.csv
    ? loadFromCsv(options)
    : await loadFromDatabase(options);

  if (candles.length < MIN_BARS) {
    console.error(
      `Need at least ${MIN_BARS} bars to warm up the indicators; got ${candles.length}.` +
        (options.symbol ? ' Run `npm run backfill` to load history first.' : ''),
    );
    process.exitCode = 1;
    return;
  }

  const openingCash = fromRupees(options.capital);

  console.log('AI Trading Platform — backtest');
  console.log(`Data: ${source}`);
  console.log(`Bars: ${candles.length}, opening capital ${format(openingCash)}\n`);

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

  // Walk-forward needs enough bars for at least one train/test split; below that
  // the report would be empty and the efficiency figure meaningless.
  const trainBars = 400;
  const testBars = 150;
  if (candles.length < trainBars + testBars) {
    console.log(
      `\nWalk-forward validation skipped — needs ${trainBars + testBars} bars, have ${candles.length}.`,
    );
    return;
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
      trainBars,
      testBars,
      objective: (metrics) => metrics.sharpe,
    },
  );

  for (const [index, fold] of report.folds.entries()) {
    const params = fold.selectedParams;
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
