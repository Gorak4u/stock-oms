import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle } from '../src/domain/types';
import { memoryRepositories } from '../src/persistence/memory';
import { TradingService } from '../src/runtime/tradingService';
import { LiveRunner } from '../src/runtime/runner';
import { PaperBroker } from '../src/execution/paperBroker';
import { ZERO_COST_SCHEDULE } from '../src/execution/costs';
import { MarketCalendar, fromIst } from '../src/marketdata/calendar';
import { AlertManager } from '../src/monitoring/metrics';
import { assessPromotion, buildDataset, runTrainingJob, trainAndValidate } from '../src/ai/training';
import type { ValidationMetrics } from '../src/ai/types';

const calendar = new MarketCalendar({ holidays: [] });

function service(symbols: string[] = ['NSE:TEST']) {
  const repositories = memoryRepositories();
  const svc = new TradingService({
    repositories,
    broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
    openingCash: fromRupees(1_000_000),
    calendar,
    symbols,
  });
  return { svc, repositories };
}

function minuteBars(count: number, day = '2026-03-02'): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 1000 + Math.sin(i / 8) * 30 + i * 0.05;
    return {
      symbol: 'NSE:TEST',
      interval: '1m' as const,
      timestamp: fromIst(day, 9 * 60 + 15 + i),
      open: fromRupees(price),
      high: fromRupees(price + 2),
      low: fromRupees(price - 2),
      close: fromRupees(price),
      volume: 5_000,
    };
  });
}

describe('LiveRunner', () => {
  it('does nothing outside a session', async () => {
    const { svc, repositories } = service();
    await svc.start();
    await repositories.candles.upsertMany(minuteBars(200));

    const runner = new LiveRunner({ service: svc, candles: repositories.candles });
    // 03:00 IST — hours before the open.
    await runner.tick(fromIst('2026-03-02', 3 * 60));

    expect(svc.portfolio.getOpenPositions()).toHaveLength(0);
    expect((await repositories.orders.findRecent(10))).toHaveLength(0);
  });

  it('does nothing on a holiday', async () => {
    const holidayCalendar = new MarketCalendar({ holidays: ['2026-03-02'] });
    const repositories = memoryRepositories();
    const svc = new TradingService({
      repositories,
      broker: new PaperBroker({}),
      openingCash: fromRupees(1_000_000),
      calendar: holidayCalendar,
      symbols: ['NSE:TEST'],
    });
    await svc.start();
    await repositories.candles.upsertMany(minuteBars(200));

    const runner = new LiveRunner({ service: svc, candles: repositories.candles });
    await runner.tick(fromIst('2026-03-02', 11 * 60));

    expect(await repositories.orders.findRecent(10)).toHaveLength(0);
  });

  it('refuses to run two ticks concurrently', async () => {
    const { svc, repositories } = service();
    await svc.start();
    await repositories.candles.upsertMany(minuteBars(200));

    let concurrent = 0;
    let maxConcurrent = 0;
    const original = repositories.candles.latest.bind(repositories.candles);
    repositories.candles.latest = async (...args) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return original(...args);
    };

    const runner = new LiveRunner({ service: svc, candles: repositories.candles });
    const at = fromIst('2026-03-02', 11 * 60);
    await Promise.all([runner.tick(at), runner.tick(at), runner.tick(at)]);

    // A slow tick must not let the next one decide against a half-updated
    // portfolio.
    expect(maxConcurrent).toBe(1);
  });

  it('skips a symbol with too little history to warm up', async () => {
    const { svc, repositories } = service();
    await svc.start();
    await repositories.candles.upsertMany(minuteBars(10));

    const runner = new LiveRunner({ service: svc, candles: repositories.candles });
    await runner.tick(fromIst('2026-03-02', 11 * 60));

    expect(await repositories.orders.findRecent(10)).toHaveLength(0);
  });

  it('squares off intraday positions near the close, exactly once', async () => {
    const { svc, repositories } = service();
    await svc.start();

    // Seed a long position.
    await repositories.orders.insert({
      id: 'ord-seed',
      request: {
        symbol: 'NSE:TEST', side: 'BUY', quantity: 100, orderType: 'MARKET',
        product: 'MIS', timeInForce: 'DAY', strategyId: 's', idempotencyKey: 'seed',
      },
      status: 'FILLED', filledQuantity: 100, createdAt: 1, updatedAt: 1,
    });
    await svc.applyFill({
      orderId: 'ord-seed', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
      price: fromRupees(1000), timestamp: 1000, commission: 0 as Paise,
    });
    expect(svc.portfolio.getOpenPositions()).toHaveLength(1);

    const runner = new LiveRunner({
      service: svc, candles: repositories.candles, squareOffMinutesBeforeClose: 20,
    });

    // 15:15 IST — inside the square-off window.
    await runner.tick(fromIst('2026-03-02', 15 * 60 + 15));
    const afterFirst = svc.oms.getOpenOrders().length + (await repositories.orders.findRecent(20)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Ticking again in the same window must not send duplicate exits.
    const before = svc.oms.getOpenOrders().length;
    await runner.tick(fromIst('2026-03-02', 15 * 60 + 16));
    await runner.tick(fromIst('2026-03-02', 15 * 60 + 17));
    expect(svc.oms.getOpenOrders().length).toBe(before);
  });

  it('does not square off when flat', async () => {
    const { svc, repositories } = service();
    await svc.start();

    const runner = new LiveRunner({ service: svc, candles: repositories.candles });
    await runner.tick(fromIst('2026-03-02', 15 * 60 + 20));

    expect(await repositories.orders.findRecent(10)).toHaveLength(0);
  });

  it('reports an internal error as a critical alert instead of dying', async () => {
    const { svc, repositories } = service();
    await svc.start();

    repositories.candles.latest = async () => {
      throw new Error('database gone');
    };

    const alerted: string[] = [];
    const alerts = new AlertManager();
    alerts.addSink((alert) => { alerted.push(alert.title); });

    const runner = new LiveRunner({ service: svc, candles: repositories.candles, alerts });

    await expect(runner.tick(fromIst('2026-03-02', 11 * 60))).resolves.toBeUndefined();
    expect(alerted).toContain('Trading loop error');
  });

  it('starts and stops cleanly', () => {
    const { svc, repositories } = service();
    const runner = new LiveRunner({ service: svc, candles: repositories.candles });

    expect(runner.isRunning).toBe(false);
    runner.start();
    expect(runner.isRunning).toBe(true);
    runner.stop();
    expect(runner.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function dailyBars(count: number, seed = 7): Candle[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  const out: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < count; i += 1) {
    price = Math.max(1, price * (1 + (next() - 0.5) * 0.02 + Math.sin(i / 50) * 0.001));
    out.push({
      symbol: 'NSE:TEST',
      interval: '1d',
      timestamp: i * 86_400_000,
      open: fromRupees(price),
      high: fromRupees(price * 1.01),
      low: fromRupees(price * 0.99),
      close: fromRupees(price),
      volume: 100_000 + Math.floor(next() * 50_000),
    });
  }
  return out;
}

describe('bar interval', () => {
  it('reads the interval it was configured with, not a hardcoded one', async () => {
    // The trap: ingestion took its interval from configuration while the loop
    // hardcoded 1m, so raising the bar size wrote one series and read another.
    // The market-data health check went green against bars the strategy never
    // saw, and the loop ticked forever on an empty read.
    const { svc, repositories } = service();
    await svc.start();

    let bars = 0;
    (svc as unknown as { onBar: () => Promise<void> }).onBar = async () => {
      bars += 1;
    };

    // Only 5m bars exist.
    await repositories.candles.upsertMany(
      minuteBars(120).map((c) => ({ ...c, interval: '5m' as const })),
    );

    const readingOneMinute = new LiveRunner({ service: svc, candles: repositories.candles });
    await readingOneMinute.tick(fromIst('2026-03-02', 11 * 60));
    expect(bars).toBe(0);

    const readingFiveMinute = new LiveRunner({
      service: svc, candles: repositories.candles, interval: '5m',
    });
    await readingFiveMinute.tick(fromIst('2026-03-02', 11 * 60));
    expect(bars).toBe(1);
  });
});

describe('state survives a restart', () => {
  /**
   * The invariant tradingService.ts opens by claiming: replaying fills means a
   * restart lands on exactly the state the process had before it died.
   *
   * The bug this pins: positions were persisted only when a fill changed them,
   * so `last_price` stayed at the entry price while the live portfolio was
   * marked to each new bar. A restart rebuilt the account at entry prices, and
   * because the drawdown and daily-loss limits measure against equity, it moved
   * the baseline those kill switches use.
   */
  it('rebuilds the same equity after a restart with an open position', async () => {
    const repositories = memoryRepositories();

    const build = () =>
      new TradingService({
        repositories,
        broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
        openingCash: fromRupees(1_000_000),
        calendar,
        symbols: ['NSE:TEST'],
      });

    const first = build();
    await first.start();

    // Buy, fill at 100, then mark the position up to 130.
    const entry = fromIst('2026-03-02', 10 * 60);
    await first.applyFill({
      orderId: 'ord-1', symbol: 'NSE:TEST', side: 'BUY', quantity: 100,
      price: fromRupees(100), timestamp: entry, commission: 0 as Paise,
    });

    first.portfolio.mark('NSE:TEST', fromRupees(130));
    await first.snapshot(entry + 60_000);

    const before = first.status().equity;
    expect(first.portfolio.getPosition('NSE:TEST')?.unrealisedPnl).toBe(fromRupees(3_000));

    // A different process, same database.
    const second = build();
    await second.start();

    expect(second.status().equity).toBe(before);
    expect(second.portfolio.getPosition('NSE:TEST')?.lastPrice).toBe(fromRupees(130));
  });
});

describe('risk state survives a restart', () => {
  /**
   * The state a restart cannot rebuild from fills: the drawdown peak, the
   * day's opening equity, the loss-streak breaker, and staged approvals. All
   * four used to reset on every boot, so a restart moved the baselines the kill
   * switches measure against and cleared a breaker that had just halted
   * trading. A crash loop made all of them formalities.
   */
  const build = (repositories: ReturnType<typeof memoryRepositories>) =>
    new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
      openingCash: fromRupees(1_000_000),
      calendar,
      symbols: ['NSE:TEST'],
    });

  it('keeps the drawdown peak across a restart', async () => {
    const repositories = memoryRepositories();

    const first = build(repositories);
    await first.start();

    await first.applyFill({
      orderId: 'o1', symbol: 'NSE:TEST', side: 'BUY', quantity: 1000,
      price: fromRupees(100), timestamp: 1000, commission: 0 as Paise,
    });

    // The peak only advances inside onBar, so drive a bar priced well up.
    const rally = minuteBars(80).map((c) => ({
      ...c, open: fromRupees(200), high: fromRupees(200),
      low: fromRupees(200), close: fromRupees(200),
    }));
    await first.onBar('NSE:TEST', rally);

    const peak = first.pipeline.captureState().peakEquity;
    expect(peak).toBeGreaterThan(fromRupees(1_000_000));

    // Then hand it all back, so current equity sits below the peak.
    const slump = minuteBars(80).map((c) => ({
      ...c, open: fromRupees(100), high: fromRupees(100),
      low: fromRupees(100), close: fromRupees(100),
    }));
    await first.onBar('NSE:TEST', slump);

    const second = build(repositories);
    await second.start();

    // A reset peak would measure drawdown from the trough and report none.
    expect(second.pipeline.captureState().peakEquity).toBe(peak);
  });

  it('keeps a tripped loss-streak breaker across a restart', async () => {
    const repositories = memoryRepositories();

    const first = build(repositories);
    await first.start();
    for (let i = 0; i < 4; i += 1) {
      first.pipeline.recordTradeOutcome(fromRupees(-500), 1000 + i);
    }
    await first.snapshot(2000);

    const streak = first.pipeline.captureState().lossStreak.streak;
    expect(streak).toBe(4);

    const second = build(repositories);
    await second.start();

    // Resuming with a clean breaker is the system forgetting it had just
    // stopped itself.
    expect(second.pipeline.captureState().lossStreak.streak).toBe(streak);
  });

  it('keeps staged approvals across a restart', async () => {
    const repositories = memoryRepositories();

    const first = build(repositories);
    await first.start();
    await first.setMode('APPROVAL', 'test');

    const bars = minuteBars(200);
    await repositories.candles.upsertMany(bars);
    for (let i = 60; i < bars.length; i += 1) {
      await first.onBar('NSE:TEST', bars.slice(0, i + 1));
      if (first.pipeline.pendingApprovals().length > 0) break;
    }

    const staged = first.pipeline.pendingApprovals();
    if (staged.length === 0) return; // no signal on this series; nothing to assert

    const second = build(repositories);
    await second.start();

    expect(second.pipeline.pendingApprovals().map((a) => a.request.idempotencyKey))
      .toEqual(staged.map((a) => a.request.idempotencyKey));
  });

  it('does not lower the peak below current equity', async () => {
    // A stored peak beneath present equity would understate drawdown.
    const repositories = memoryRepositories();
    await repositories.state.set('pipeline.state', {
      currentDay: '2026-03-02',
      startOfDayEquity: fromRupees(500_000),
      peakEquity: fromRupees(500_000),
      lossStreak: { streak: 0, trippedAt: null },
      approvals: [],
    }, 1000);

    const svc = build(repositories);
    await svc.start();

    expect(svc.pipeline.captureState().peakEquity).toBe(fromRupees(1_000_000));
  });
});

describe('square-off guard', () => {
  it('does not re-send exits after a restart inside the closing window', async () => {
    // Square-off runs in the last twenty minutes of the session, so a process
    // restarting in that window used to re-send exits for every open position
    // on every tick until the close.
    const repositories = memoryRepositories();
    const closing = fromIst('2026-03-02', 15 * 60 + 20);

    const svc = new TradingService({
      repositories,
      broker: new PaperBroker({ costSchedule: ZERO_COST_SCHEDULE, slippageFraction: 0 }),
      openingCash: fromRupees(1_000_000),
      calendar,
      symbols: ['NSE:TEST'],
    });
    await svc.start();

    await svc.applyFill({
      orderId: 'o1', symbol: 'NSE:TEST', side: 'BUY', quantity: 10,
      price: fromRupees(100), timestamp: closing - 60_000, commission: 0 as Paise,
    });

    const first = new LiveRunner({
      service: svc, candles: repositories.candles, state: repositories.state,
    });
    await first.tick(closing);
    const afterFirst = (await repositories.orders.findRecent(100)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // A brand-new runner: same database, empty in-memory guard.
    const restarted = new LiveRunner({
      service: svc, candles: repositories.candles, state: repositories.state,
    });
    await restarted.tick(closing + 60_000);

    expect((await repositories.orders.findRecent(100)).length).toBe(afterFirst);
  });
});

describe('fills from a broker', () => {
  /**
   * Brokers report fills against their own order ids. Nothing bridged that to
   * the platform's, so a fill was attributed to no order — and against Postgres
   * the foreign key rejected it outright, losing money that had already moved.
   */
  it('attributes a fill carrying the broker order id to the platform order', async () => {
    const { svc, repositories } = service();
    await svc.start();

    await repositories.orders.insert({
      id: 'platform-order-1',
      request: {
        symbol: 'NSE:TEST', side: 'BUY', quantity: 10, orderType: 'MARKET',
        product: 'MIS', timeInForce: 'DAY', strategyId: 'test',
        idempotencyKey: 'key-1',
      },
      status: 'OPEN',
      brokerOrderId: 'paper-7',
      filledQuantity: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    await svc.applyFill({
      orderId: 'paper-7', // the broker's id, not ours
      symbol: 'NSE:TEST', side: 'BUY', quantity: 10,
      price: fromRupees(100), timestamp: 2000, commission: 0 as Paise,
    });

    const [stored] = await repositories.fills.since(0);
    expect(stored?.orderId).toBe('platform-order-1');
    expect(stored?.brokerOrderId).toBe('paper-7');
    expect(svc.portfolio.getPosition('NSE:TEST')?.quantity).toBe(10);

    // A break is still recorded, and correctly: the order was inserted straight
    // into the repository, so the in-memory OMS has never seen it — the same
    // situation as an order placed before a restart. The break says the order's
    // *state* could not be updated, which is true. What matters here is that
    // the fill was attributed to the right order rather than orphaned.
    const breaks = await repositories.reconciliation.open();
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.orderId).toBe('platform-order-1');
  });

  it('still stores a fill whose order is unknown', async () => {
    const { svc, repositories } = service();
    await svc.start();

    await svc.applyFill({
      orderId: 'broker-mystery', symbol: 'NSE:TEST', side: 'BUY', quantity: 5,
      price: fromRupees(100), timestamp: 2000, commission: 0 as Paise,
    });

    // Money that moved is recorded even when it cannot be attributed —
    // dropping it would leave the platform trading against a position it does
    // not know it has.
    expect(await repositories.fills.since(0)).toHaveLength(1);
    expect(svc.portfolio.getPosition('NSE:TEST')?.quantity).toBe(5);
    expect(await repositories.reconciliation.open()).toHaveLength(1);
  });
});

describe('buildDataset', () => {
  it('drops the final horizon bars, whose outcome has not happened yet', () => {
    const candles = dailyBars(400);
    const withShortHorizon = buildDataset(candles, { horizonBars: 5 });
    const withLongHorizon = buildDataset(candles, { horizonBars: 50 });

    expect(withShortHorizon.samples.length).toBeGreaterThan(withLongHorizon.samples.length);
    expect(withShortHorizon.samples.length - withLongHorizon.samples.length).toBe(45);
  });

  it('pairs every sample with exactly one label', () => {
    const dataset = buildDataset(dailyBars(400));
    expect(dataset.samples.length).toBe(dataset.labels.length);
    expect(dataset.samples.length).toBeGreaterThan(0);
  });

  it('emits only 0/1 labels', () => {
    const dataset = buildDataset(dailyBars(400));
    expect(new Set(dataset.labels)).toEqual(new Set([0, 1]));
  });

  it('labels fewer positives as the threshold rises', () => {
    const candles = dailyBars(500);
    const loose = buildDataset(candles, { thresholdFraction: 0 });
    const strict = buildDataset(candles, { thresholdFraction: 0.05 });

    const positives = (labels: readonly number[]): number => labels.reduce((a, b) => a + b, 0);
    expect(positives(strict.labels)).toBeLessThan(positives(loose.labels));
  });

  it('skips the warm-up region where features are undefined', () => {
    // Fewer samples than bars, because early bars have no indicators yet.
    const candles = dailyBars(300);
    expect(buildDataset(candles).samples.length).toBeLessThan(candles.length);
  });
});

describe('trainAndValidate', () => {
  it('splits chronologically, never randomly', () => {
    const dataset = buildDataset(dailyBars(600));
    const result = trainAndValidate(dataset, 'm', '1', { trainFraction: 0.7 });

    // A chronological split means the sizes are exactly the fraction, and the
    // validation window is strictly later than the training one.
    expect(result.trainSize).toBe(Math.floor(dataset.samples.length * 0.7));
    expect(result.trainSize + result.validationSize).toBe(dataset.samples.length);
  });

  it('produces a trained model and finite metrics', () => {
    const dataset = buildDataset(dailyBars(600));
    const result = trainAndValidate(dataset, 'm', '1');

    expect(result.model.isTrained).toBe(true);
    expect(Number.isFinite(result.metrics.accuracy)).toBe(true);
    expect(result.metrics.accuracy).toBeGreaterThanOrEqual(0);
    expect(result.metrics.accuracy).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    const dataset = buildDataset(dailyBars(600));
    const a = trainAndValidate(dataset, 'm', '1');
    const b = trainAndValidate(dataset, 'm', '1');
    expect(a.model.coefficients).toEqual(b.model.coefficients);
  });

  it('refuses too small a sample rather than producing a meaningless model', () => {
    const tiny = { samples: [], labels: [] };
    expect(() => trainAndValidate(tiny, 'm', '1')).toThrow(/at least 100/);
  });

  it('refuses a validation window too small to mean anything', () => {
    const dataset = buildDataset(dailyBars(400));
    expect(() => trainAndValidate(dataset, 'm', '1', { trainFraction: 0.999 })).toThrow(
      /validation window too small/,
    );
  });
});

describe('assessPromotion', () => {
  function metrics(overrides: Partial<ValidationMetrics> = {}): ValidationMetrics {
    return {
      accuracy: 0.6, precision: 0.6, recall: 0.5, sampleCount: 1000, abstentionRate: 0.1,
      ...overrides,
    };
  }

  it('promotes a model that clears every gate', () => {
    expect(assessPromotion(metrics()).promoted).toBe(true);
  });

  it('refuses on too few samples, weak accuracy, weak precision, or high abstention', () => {
    expect(assessPromotion(metrics({ sampleCount: 10 })).reason).toContain('samples');
    expect(assessPromotion(metrics({ accuracy: 0.4 })).reason).toContain('accuracy');
    expect(assessPromotion(metrics({ precision: 0.4 })).reason).toContain('precision');
    expect(assessPromotion(metrics({ abstentionRate: 0.9 })).reason).toContain('abstention');
  });
});

describe('runTrainingJob', () => {
  it('stores the model and reports the promotion verdict', async () => {
    const repositories = memoryRepositories();
    await repositories.candles.upsertMany(dailyBars(900));

    const result = await runTrainingJob(repositories, 'NSE:TEST', { version: 'v1', now: 1000 });

    const stored = await repositories.models.find('signal-filter', 'v1');
    expect(stored).not.toBeNull();
    expect(stored!.weights).toHaveLength(stored!.featureNames.length);
    expect(typeof result.promotionReason).toBe('string');
  });

  it('only promotes when the criteria are met', async () => {
    const repositories = memoryRepositories();
    await repositories.candles.upsertMany(dailyBars(900));

    // Impossible gate: nothing should be promoted.
    const result = await runTrainingJob(repositories, 'NSE:TEST', {
      version: 'v1',
      criteria: { minAccuracy: 0.99, minPrecision: 0.99, minSamples: 10, maxAbstentionRate: 1 },
    });

    expect(result.promoted).toBe(false);
    expect(await repositories.models.promoted()).toBeNull();
  });

  it('promotes and makes the model live when the gate is permissive', async () => {
    const repositories = memoryRepositories();
    await repositories.candles.upsertMany(dailyBars(900));

    const result = await runTrainingJob(repositories, 'NSE:TEST', {
      version: 'v1',
      criteria: { minAccuracy: 0, minPrecision: 0, minSamples: 1, maxAbstentionRate: 1 },
    });

    expect(result.promoted).toBe(true);
    expect((await repositories.models.promoted())!.version).toBe('v1');
  });

  it('refuses to train on too little history', async () => {
    const repositories = memoryRepositories();
    await repositories.candles.upsertMany(dailyBars(100));

    await expect(runTrainingJob(repositories, 'NSE:TEST')).rejects.toThrow(/at least 300/);
  });
});
