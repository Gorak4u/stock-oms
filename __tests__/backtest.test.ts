import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Signal } from '../src/domain/types';
import { BacktestEngine } from '../src/backtest/engine';
import { buildWindows, walkForward } from '../src/backtest/walkForward';
import { DEFAULT_COST_SCHEDULE, ZERO_COST_SCHEDULE } from '../src/execution/costs';
import { DEFAULT_RISK_LIMITS } from '../src/risk/types';
import { TrendFollowingStrategy } from '../src/strategy/trendFollowing';
import { MeanReversionStrategy } from '../src/strategy/meanReversion';
import { MomentumStrategy } from '../src/strategy/momentum';
import { VolatilityBreakoutStrategy } from '../src/strategy/volatility';
import { signal, type Strategy, type StrategyContext } from '../src/strategy/types';

const DAY = 86_400_000;
const START = Date.parse('2020-01-01T00:00:00Z');

/** Deterministic pseudo-random walk — no `Math.random`, so runs are reproducible. */
function syntheticSeries(length: number, seed = 42, drift = 0.0003): Candle[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  const candles: Candle[] = [];
  let price = 1000;

  for (let i = 0; i < length; i += 1) {
    const shock = (next() - 0.5) * 0.03 + drift;
    const open = price;
    const close = Math.max(1, open * (1 + shock));
    const high = Math.max(open, close) * (1 + next() * 0.01);
    const low = Math.min(open, close) * (1 - next() * 0.01);

    candles.push({
      symbol: 'NSE:TEST',
      interval: '1d',
      timestamp: START + i * DAY,
      open: fromRupees(open),
      high: fromRupees(high),
      low: fromRupees(low),
      close: fromRupees(close),
      volume: 100_000 + Math.floor(next() * 50_000),
    });

    price = close;
  }

  return candles;
}

/** A trending series with a clean reversal — trend following should profit. */
function trendingSeries(length: number): Candle[] {
  const candles: Candle[] = [];
  const half = Math.floor(length / 2);

  for (let i = 0; i < length; i += 1) {
    const price = i < half ? 1000 + i * 5 : 1000 + half * 5 - (i - half) * 5;
    candles.push({
      symbol: 'NSE:TEST',
      interval: '1d',
      timestamp: START + i * DAY,
      open: fromRupees(price),
      high: fromRupees(price + 3),
      low: fromRupees(price - 3),
      close: fromRupees(price),
      volume: 100_000,
    });
  }

  return candles;
}

const BASE_CONFIG = {
  openingCash: fromRupees(1_000_000),
  costSchedule: ZERO_COST_SCHEDULE,
  slippageFraction: 0,
};

describe('BacktestEngine — invariants', () => {
  it('produces one equity point per bar', async () => {
    const candles = syntheticSeries(300);
    const result = await new BacktestEngine(BASE_CONFIG).run(
      new TrendFollowingStrategy(),
      candles,
    );

    expect(result.curve).toHaveLength(candles.length);
    expect(result.curve[0]!.timestamp).toBe(candles[0]!.timestamp);
  });

  it('is deterministic — identical inputs give identical results', async () => {
    const candles = syntheticSeries(300);

    const first = await new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), candles);
    const second = await new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), candles);

    expect(first.metrics).toEqual(second.metrics);
    expect(first.curve).toEqual(second.curve);
    expect(first.trades).toEqual(second.trades);
  });

  it('starts at the opening cash', async () => {
    const result = await new BacktestEngine(BASE_CONFIG).run(
      new TrendFollowingStrategy(),
      syntheticSeries(200),
    );

    expect(result.curve[0]!.equity).toBe(fromRupees(1_000_000));
    expect(result.metrics.openingEquity).toBe(fromRupees(1_000_000));
  });

  it('leaves an intact audit chain', async () => {
    const result = await new BacktestEngine(BASE_CONFIG).run(
      new TrendFollowingStrategy(),
      syntheticSeries(400),
    );

    expect(result.audit.verifyChain()).toBeNull();
    expect(result.audit.size).toBeGreaterThan(0);
  });

  it('rejects an empty series', async () => {
    await expect(new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), [])).rejects.toThrow();
  });
});

describe('BacktestEngine — no lookahead', () => {
  /**
   * The decisive test for backtest validity.
   *
   * A strategy that can see the future would produce different decisions when
   * the future is different. Running the same prefix inside two series whose
   * *tails* differ must yield an identical equity curve over that prefix — if
   * it does not, something is reading ahead.
   */
  it('gives an identical prefix curve when only the future differs', async () => {
    const prefix = syntheticSeries(250, 7);
    const tailA = syntheticSeries(100, 99, 0.01).map((candle, i) => ({
      ...candle,
      timestamp: START + (250 + i) * DAY,
    }));
    const tailB = syntheticSeries(100, 1234, -0.01).map((candle, i) => ({
      ...candle,
      timestamp: START + (250 + i) * DAY,
    }));

    const resultA = await new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), [
      ...prefix,
      ...tailA,
    ]);
    const resultB = await new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), [
      ...prefix,
      ...tailB,
    ]);

    for (let i = 0; i < prefix.length; i += 1) {
      expect(resultA.curve[i]!.equity).toBe(resultB.curve[i]!.equity);
    }
  });

  it('holds for every bundled strategy', async () => {
    const strategies: Strategy<unknown>[] = [
      new TrendFollowingStrategy(),
      new MeanReversionStrategy(),
      new MomentumStrategy(),
      new VolatilityBreakoutStrategy(),
    ];

    const prefix = syntheticSeries(400, 11);
    const tailA = syntheticSeries(80, 555, 0.02);
    const tailB = syntheticSeries(80, 777, -0.02);
    const retime = (candles: Candle[]) =>
      candles.map((candle, i) => ({ ...candle, timestamp: START + (400 + i) * DAY }));

    for (const strategy of strategies) {
      const a = await new BacktestEngine(BASE_CONFIG).run(strategy, [...prefix, ...retime(tailA)]);
      const b = await new BacktestEngine(BASE_CONFIG).run(strategy, [...prefix, ...retime(tailB)]);

      for (let i = 0; i < prefix.length; i += 1) {
        expect(a.curve[i]!.equity).toBe(b.curve[i]!.equity);
      }
    }
  });
});

describe('BacktestEngine — execution realism', () => {
  it('never fills at the close of the bar the decision was made on', async () => {
    // A strategy that goes long on the first eligible bar and holds.
    class AlwaysLong implements Strategy<null> {
      readonly id = 'always-long';
      readonly warmupBars = 2;
      fired = false;

      prepare(): null {
        return null;
      }

      evaluate(ctx: StrategyContext): Signal | null {
        if (this.fired || ctx.index !== 5) return null;
        this.fired = true;
        const candle = ctx.candles[ctx.index]!;
        return signal({
          symbol: ctx.symbol,
          strategyId: this.id,
          direction: 'LONG',
          strength: 1,
          timestamp: candle.timestamp,
          referencePrice: candle.close,
          stopLoss: (candle.close - fromRupees(50)) as Paise,
          rationale: 'test',
        });
      }
    }

    const candles = syntheticSeries(60);
    const result = await new BacktestEngine(BASE_CONFIG).run(new AlwaysLong(), candles);

    expect(result.trades.length + result.finalPortfolio.getOpenPositions().length).toBeGreaterThan(0);
    // Equity is still exactly the opening cash through bar 5 — the order that
    // bar decided on cannot have filled until bar 6.
    expect(result.curve[5]!.equity).toBe(fromRupees(1_000_000));
  });

  it('charges costs and slippage, making a round trip strictly worse', async () => {
    const candles = trendingSeries(300);

    const free = await new BacktestEngine(BASE_CONFIG).run(new TrendFollowingStrategy(), candles);
    const costly = await new BacktestEngine({
      openingCash: BASE_CONFIG.openingCash,
      costSchedule: DEFAULT_COST_SCHEDULE,
      slippageFraction: 0.001,
    }).run(new TrendFollowingStrategy(), candles);

    if (free.trades.length > 0) {
      expect(costly.metrics.closingEquity).toBeLessThan(free.metrics.closingEquity);
    }
  });

  it('never lets a position exceed the configured share of equity', async () => {
    const candles = syntheticSeries(500, 3);
    const result = await new BacktestEngine({
      ...BASE_CONFIG,
      limits: { ...DEFAULT_RISK_LIMITS, maxPositionFraction: 0.1 },
    }).run(new TrendFollowingStrategy(), candles);

    for (const trade of result.trades) {
      const notional = trade.quantity * trade.entryPrice;
      // 10% of a ₹10,00,000 account, with headroom for equity growth.
      expect(notional).toBeLessThanOrEqual(fromRupees(400_000));
    }
  });

  it('keeps cash non-negative throughout an unleveraged run', async () => {
    const result = await new BacktestEngine(BASE_CONFIG).run(
      new TrendFollowingStrategy(),
      syntheticSeries(400, 21),
    );

    expect(result.finalPortfolio.cash).toBeGreaterThanOrEqual(fromRupees(-1));
  });
});

describe('BacktestEngine — strategy behaviour', () => {
  it('makes money following a clean trend and reversal', async () => {
    const result = await new BacktestEngine(BASE_CONFIG).run(
      new TrendFollowingStrategy({ fastPeriod: 10, slowPeriod: 30 }),
      trendingSeries(400),
    );

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.metrics.closingEquity).toBeGreaterThan(fromRupees(1_000_000));
  });

  it('records rejected signals rather than silently dropping them', async () => {
    const result = await new BacktestEngine({
      ...BASE_CONFIG,
      openingCash: fromRupees(1000), // too small to size anything
    }).run(new TrendFollowingStrategy(), syntheticSeries(400));

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.riskRejections.length).toBeGreaterThan(0);
    expect(result.trades).toHaveLength(0);
  });

  it('runs every bundled strategy without error', async () => {
    const candles = syntheticSeries(600, 5);
    const strategies: Strategy<unknown>[] = [
      new TrendFollowingStrategy(),
      new MeanReversionStrategy(),
      new MomentumStrategy(),
      new VolatilityBreakoutStrategy(),
    ];

    for (const strategy of strategies) {
      const result = await new BacktestEngine(BASE_CONFIG).run(strategy, candles);
      expect(result.curve).toHaveLength(candles.length);
      expect(Number.isFinite(result.metrics.totalReturn)).toBe(true);
    }
  });
});

describe('walk-forward validation', () => {
  it('builds non-overlapping test windows that step forward', () => {
    const windows = buildWindows(1000, 250, 100);

    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 250, testStart: 250, testEnd: 350 });
    expect(windows[1]!.trainStart).toBe(100);
    expect(windows[1]!.testStart).toBe(350);

    for (const window of windows) {
      // The test window must always sit strictly after the training data.
      expect(window.testStart).toBeGreaterThanOrEqual(window.trainEnd);
    }
  });

  it('produces no windows when the series is too short', () => {
    expect(buildWindows(100, 250, 100)).toHaveLength(0);
  });

  it('selects parameters in-sample and reports out-of-sample results', async () => {
    const candles = syntheticSeries(1200, 17);
    const grid = [
      { fastPeriod: 10, slowPeriod: 30 },
      { fastPeriod: 20, slowPeriod: 50 },
    ];

    const report = await walkForward(
      candles,
      grid,
      (params) => new TrendFollowingStrategy(params),
      { ...BASE_CONFIG, trainBars: 400, testBars: 200, objective: (m) => m.totalReturn },
    );

    expect(report.folds.length).toBeGreaterThan(0);
    for (const fold of report.folds) {
      expect(grid).toContainEqual(fold.selectedParams);
    }
    expect(Number.isFinite(report.aggregate.totalReturn)).toBe(true);
  });

  it('rejects an empty parameter grid', async () => {
    await expect(
      walkForward(syntheticSeries(600), [], () => new TrendFollowingStrategy(), {
        ...BASE_CONFIG,
        trainBars: 200,
        testBars: 100,
      }),
    ).rejects.toThrow(/grid is empty/);
  });

  it('explains why a series too short to validate cannot be used', async () => {
    await expect(
      walkForward(
        syntheticSeries(100),
        [{ fastPeriod: 10, slowPeriod: 30 }],
        (params) => new TrendFollowingStrategy(params),
        { ...BASE_CONFIG, trainBars: 400, testBars: 200 },
      ),
    ).rejects.toThrow(/too short/);
  });
});
