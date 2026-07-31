import { fromRupees, type Paise } from '../src/domain/money';
import type { ClosedTrade } from '../src/execution/portfolio';
import {
  computeDrawdown,
  computeMetrics,
  equityReturns,
  sharpeRatio,
  sortinoRatio,
  type EquityPoint,
} from '../src/backtest/metrics';

function curve(values: number[]): EquityPoint[] {
  return values.map((value, i) => ({ timestamp: i * 86_400_000, equity: fromRupees(value) }));
}

function trade(pnl: number): ClosedTrade {
  return {
    symbol: 'NSE:RELIANCE',
    direction: 'LONG',
    quantity: 10,
    entryPrice: fromRupees(100),
    exitPrice: fromRupees(100 + pnl / 10),
    pnl: fromRupees(pnl),
    closedAt: 0,
  };
}

describe('computeDrawdown', () => {
  it('finds the deepest peak-to-trough decline', () => {
    const result = computeDrawdown(curve([100, 120, 90, 110, 150]));

    // Peak 120 → trough 90 is 25%.
    expect(result.maxDrawdown).toBeCloseTo(0.25, 10);
    expect(result.maxDrawdownAmount).toBe(fromRupees(30));
  });

  it('is zero for a monotonically rising curve', () => {
    const result = computeDrawdown(curve([100, 110, 120, 130]));
    expect(result.maxDrawdown).toBe(0);
    expect(result.longestUnderwaterBars).toBe(0);
  });

  it('measures recovery from the peak, not from the trough', () => {
    // Peak at index 1, trough at 2, recovered at 4.
    const result = computeDrawdown(curve([100, 120, 90, 100, 120]));
    expect(result.recoveryBars).toBe(3);
  });

  it('reports no recovery when equity never regains the peak', () => {
    const result = computeDrawdown(curve([100, 120, 90, 95, 100]));
    expect(result.recoveryBars).toBeNull();
  });

  it('tracks the longest underwater stretch', () => {
    const result = computeDrawdown(curve([100, 90, 85, 95, 105, 100]));
    expect(result.longestUnderwaterBars).toBeGreaterThanOrEqual(3);
  });

  it('handles an empty curve', () => {
    expect(computeDrawdown([]).maxDrawdown).toBe(0);
  });
});

describe('equityReturns', () => {
  it('computes bar-over-bar simple returns', () => {
    const returns = equityReturns(curve([100, 110, 99]));
    expect(returns[0]).toBeCloseTo(0.1, 10);
    expect(returns[1]).toBeCloseTo(-0.1, 10);
  });
});

describe('sharpeRatio', () => {
  it('is zero for constant returns rather than Infinity', () => {
    // A flat curve has no risk-adjusted return; dividing by zero deviation
    // would otherwise rank a do-nothing strategy best.
    expect(sharpeRatio([0.01, 0.01, 0.01, 0.01])).toBe(0);
  });

  it('is zero when there is not enough data', () => {
    expect(sharpeRatio([])).toBe(0);
    expect(sharpeRatio([0.01])).toBe(0);
  });

  it('is positive for a profitable series and negative for a losing one', () => {
    expect(sharpeRatio([0.02, 0.01, 0.03, -0.005, 0.015])).toBeGreaterThan(0);
    expect(sharpeRatio([-0.02, -0.01, -0.03, 0.005, -0.015])).toBeLessThan(0);
  });

  it('scales by the square root of the period count', () => {
    const returns = [0.01, -0.005, 0.02, 0.003, -0.01];
    const daily = sharpeRatio(returns, 0, 252);
    const monthly = sharpeRatio(returns, 0, 12);

    expect(daily / monthly).toBeCloseTo(Math.sqrt(252 / 12), 6);
  });
});

describe('sortinoRatio', () => {
  it('ignores upside volatility', () => {
    const steady = [0.01, 0.01, 0.01, -0.005];
    const spiky = [0.01, 0.08, 0.01, -0.005];

    // The upside spike raises Sharpe's denominator but not Sortino's.
    expect(sortinoRatio(spiky)).toBeGreaterThan(sharpeRatio(spiky));
    expect(sortinoRatio(steady)).toBeGreaterThan(0);
  });

  it('is Infinity when nothing ever loses', () => {
    expect(sortinoRatio([0.01, 0.02, 0.015])).toBe(Infinity);
  });
});

describe('computeMetrics', () => {
  it('summarises a profitable run', () => {
    const metrics = computeMetrics({
      curve: curve([100_000, 105_000, 103_000, 110_000]),
      trades: [trade(5_000), trade(-2_000), trade(7_000)],
    });

    expect(metrics.totalReturn).toBeCloseTo(0.1, 10);
    expect(metrics.tradeCount).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 3, 10);
    expect(metrics.profitFactor).toBeCloseTo(6, 10); // 12,000 ÷ 2,000
    expect(metrics.expectancy).toBe(fromRupees(10_000 / 3));
  });

  it('reports a wiped-out account as -100% rather than a complex number', () => {
    const metrics = computeMetrics({ curve: curve([100_000, 50_000, 0]), trades: [] });
    expect(metrics.cagr).toBe(-1);
  });

  it('counts the longest losing streak', () => {
    const metrics = computeMetrics({
      curve: curve([100, 100]),
      trades: [trade(-1), trade(-1), trade(5), trade(-1), trade(-1), trade(-1)],
    });

    expect(metrics.maxConsecutiveLosses).toBe(3);
  });

  it('reports profit factor as Infinity only when there are wins and no losses', () => {
    expect(
      computeMetrics({ curve: curve([100, 110]), trades: [trade(10)] }).profitFactor,
    ).toBe(Infinity);
    expect(computeMetrics({ curve: curve([100, 100]), trades: [] }).profitFactor).toBe(0);
  });

  it('handles a run with no trades without dividing by zero', () => {
    const metrics = computeMetrics({ curve: curve([100_000, 100_000]), trades: [] });

    expect(metrics.tradeCount).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.expectancy).toBe(0);
    expect(Number.isNaN(metrics.totalReturn)).toBe(false);
  });

  it('reports the fraction of time capital was at risk', () => {
    const metrics = computeMetrics({
      curve: curve([100, 100, 100, 100]),
      trades: [],
      barsInMarket: 2,
    });

    expect(metrics.exposureFraction).toBe(0.5);
  });

  it('records the largest win and loss', () => {
    const metrics = computeMetrics({
      curve: curve([100, 100]),
      trades: [trade(5_000), trade(-8_000), trade(2_000)],
    });

    expect(metrics.largestWin).toBe(fromRupees(5_000));
    expect(metrics.largestLoss).toBe(fromRupees(-8_000));
  });

  it('leaves calmar at zero when there was no drawdown to divide by', () => {
    const metrics = computeMetrics({ curve: curve([100, 110, 120]), trades: [] });
    expect(metrics.calmar).toBe(0);
    expect(Number.isFinite(metrics.calmar)).toBe(true);
  });
});
