import { fromRupees, type Paise } from '../src/domain/money';
import type { OrderRequest, Position } from '../src/domain/types';
import {
  computeExposure,
  KillSwitch,
  LossStreakBreaker,
  reducingQuantity,
  RiskEngine,
} from '../src/risk/engine';
import { DEFAULT_RISK_LIMITS, type AccountState, type RiskContext } from '../src/risk/types';

const EQUITY = fromRupees(1_000_000);

function position(symbol: string, quantity: number, price: number): Position {
  return {
    symbol,
    quantity,
    averagePrice: fromRupees(price),
    realisedPnl: 0 as Paise,
    unrealisedPnl: 0 as Paise,
    lastPrice: fromRupees(price),
  };
}

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    equity: EQUITY,
    availableCash: EQUITY,
    startOfDayEquity: EQUITY,
    peakEquity: EQUITY,
    positions: [],
    dayPnl: 0 as Paise,
    consecutiveLosses: 0,
    recentOrderTimestamps: [],
    ...overrides,
  };
}

function request(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    symbol: 'NSE:RELIANCE',
    side: 'BUY',
    quantity: 10,
    orderType: 'MARKET',
    product: 'MIS',
    timeInForce: 'DAY',
    strategyId: 'test',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function context(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    request: request(),
    referencePrice: fromRupees(2500),
    stopLoss: fromRupees(2400),
    now: 1_700_000_000_000,
    marketOpen: true,
    dataIsStale: false,
    ...overrides,
  };
}

describe('computeExposure', () => {
  it('nets longs against shorts but grosses them up', () => {
    const snapshot = computeExposure([
      position('A', 100, 1000), // +₹1,00,000
      position('B', -50, 2000), // −₹1,00,000
    ]);

    expect(snapshot.gross).toBe(fromRupees(200_000));
    expect(snapshot.net).toBe(0);
    expect(snapshot.openPositions).toBe(2);
  });

  it('ignores flat positions', () => {
    const snapshot = computeExposure([position('A', 0, 1000)]);
    expect(snapshot.openPositions).toBe(0);
    expect(snapshot.gross).toBe(0);
  });
});

describe('reducingQuantity', () => {
  it('counts a sell against a long as reducing', () => {
    expect(
      reducingQuantity({ symbol: 'A', side: 'SELL', quantity: 40 }, [position('A', 100, 1000)]),
    ).toBe(40);
  });

  it('counts a buy against a short as reducing', () => {
    expect(
      reducingQuantity({ symbol: 'A', side: 'BUY', quantity: 40 }, [position('A', -100, 1000)]),
    ).toBe(40);
  });

  it('caps at the size needed to flatten — the surplus opens new risk', () => {
    expect(
      reducingQuantity({ symbol: 'A', side: 'SELL', quantity: 150 }, [position('A', 100, 1000)]),
    ).toBe(100);
  });

  it('is zero when adding to a position', () => {
    expect(
      reducingQuantity({ symbol: 'A', side: 'BUY', quantity: 40 }, [position('A', 100, 1000)]),
    ).toBe(0);
  });
});

describe('RiskEngine — risk-reducing orders', () => {
  it('lets an exit through even with the kill switch engaged', () => {
    const killSwitch = new KillSwitch();
    killSwitch.engage('manual stop', 0);
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, killSwitch);

    const decision = engine.evaluate(
      context({ request: request({ side: 'SELL', quantity: 100 }) }),
      account({ positions: [position('NSE:RELIANCE', 100, 2500)] }),
    );

    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(100);
  });

  it('lets an exit through past a breached drawdown limit', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ request: request({ side: 'SELL', quantity: 100 }) }),
      account({
        positions: [position('NSE:RELIANCE', 100, 2500)],
        equity: fromRupees(500_000),
        peakEquity: fromRupees(1_000_000),
      }),
    );

    expect(decision.approved).toBe(true);
  });

  it('still blocks an exit priced off stale data', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ request: request({ side: 'SELL', quantity: 100 }), dataIsStale: true }),
      account({ positions: [position('NSE:RELIANCE', 100, 2500)] }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections[0]!.code).toBe('STALE_MARKET_DATA');
  });

  it('does not treat a position-flipping order as risk-reducing', () => {
    const killSwitch = new KillSwitch();
    killSwitch.engage('manual stop', 0);
    const engine = new RiskEngine(DEFAULT_RISK_LIMITS, killSwitch);

    // 100 long; selling 250 closes 100 and opens 150 short.
    const decision = engine.evaluate(
      context({ request: request({ side: 'SELL', quantity: 250 }) }),
      account({ positions: [position('NSE:RELIANCE', 100, 2500)] }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('KILL_SWITCH_ENGAGED');
  });
});

describe('RiskEngine — state controls reject', () => {
  it('blocks new risk once the daily loss limit is breached', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context(),
      account({ dayPnl: fromRupees(-30_000) }), // 3% of ₹10,00,000
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('DAILY_LOSS_LIMIT');
  });

  it('blocks new risk at max drawdown', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context(),
      account({ equity: fromRupees(850_000), peakEquity: fromRupees(1_000_000) }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('MAX_DRAWDOWN');
  });

  it('trips the consecutive-loss breaker', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(context(), account({ consecutiveLosses: 4 }));

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('CONSECUTIVE_LOSS_BREAKER');
  });

  it('trips the order-rate breaker on a runaway loop', () => {
    const now = 1_700_000_000_000;
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ now }),
      account({
        recentOrderTimestamps: Array.from({ length: 30 }, (_, i) => now - i * 100),
      }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('ORDER_RATE_BREAKER');
  });

  it('ignores order timestamps older than a minute', () => {
    const now = 1_700_000_000_000;
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ now }),
      account({
        recentOrderTimestamps: Array.from({ length: 30 }, (_, i) => now - 120_000 - i * 100),
      }),
    );

    expect(decision.rejections.map((r) => r.code)).not.toContain('ORDER_RATE_BREAKER');
  });

  it('blocks entries with no protective stop when one is required', () => {
    const engine = new RiskEngine();
    const { stopLoss: _omitted, ...withoutStop } = context();
    const decision = engine.evaluate(withoutStop, account());

    expect(decision.approved).toBe(false);
    expect(decision.rejections.map((r) => r.code)).toContain('MISSING_STOP_LOSS');
  });

  it('blocks orders outside a session', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(context({ marketOpen: false }), account());

    expect(decision.rejections.map((r) => r.code)).toContain('MARKET_CLOSED');
  });

  it('reports every breached control at once, not just the first', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ marketOpen: false }),
      account({ consecutiveLosses: 9, dayPnl: fromRupees(-50_000) }),
    );

    const codes = decision.rejections.map((r) => r.code);
    expect(codes).toContain('MARKET_CLOSED');
    expect(codes).toContain('DAILY_LOSS_LIMIT');
    expect(codes).toContain('CONSECUTIVE_LOSS_BREAKER');
  });

  it('caps the number of simultaneously open positions', () => {
    const engine = new RiskEngine();
    const positions = Array.from({ length: 10 }, (_, i) => position(`SYM${i}`, 10, 100));
    const decision = engine.evaluate(context(), account({ positions }));

    expect(decision.rejections.map((r) => r.code)).toContain('MAX_OPEN_POSITIONS');
  });

  it('allows adding to an existing symbol at the position cap', () => {
    const engine = new RiskEngine();
    const positions = Array.from({ length: 10 }, (_, i) => position(`SYM${i}`, 10, 100));
    const decision = engine.evaluate(
      context({ request: request({ symbol: 'SYM0' }) }),
      account({ positions }),
    );

    expect(decision.rejections.map((r) => r.code)).not.toContain('MAX_OPEN_POSITIONS');
  });
});

describe('RiskEngine — size controls scale', () => {
  it('scales an oversized order down to the position cap instead of rejecting it', () => {
    const engine = new RiskEngine();
    // 10% of ₹10,00,000 = ₹1,00,000 ÷ ₹2,500 = 40 shares.
    const decision = engine.evaluate(
      context({ request: request({ quantity: 1000 }) }),
      account(),
    );

    expect(decision.approved).toBe(true);
    expect(decision.approvedQuantity).toBe(40);
    expect(decision.adjustments.join(' ')).toContain('max position value');
  });

  it('respects remaining symbol-concentration headroom', () => {
    const engine = new RiskEngine({ ...DEFAULT_RISK_LIMITS, maxPositionFraction: 1 });
    // 15% cap = ₹1,50,000; ₹1,00,000 already held leaves ₹50,000 = 20 shares.
    const decision = engine.evaluate(
      context({ request: request({ quantity: 1000 }) }),
      account({ positions: [position('NSE:RELIANCE', 40, 2500)] }),
    );

    expect(decision.approvedQuantity).toBe(20);
  });

  it('never approves more than the account can pay for', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ request: request({ quantity: 1000 }) }),
      account({ availableCash: fromRupees(25_000) }), // 10 shares at ₹2,500
    );

    expect(decision.approvedQuantity).toBe(10);
  });

  it('honours a per-strategy capital allocation', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ request: request({ quantity: 1000, strategyId: 'momentum' }) }),
      account({
        strategyAllocations: { momentum: fromRupees(50_000) },
        strategyExposure: { momentum: fromRupees(25_000) },
      }),
    );

    expect(decision.approvedQuantity).toBe(10); // ₹25,000 headroom ÷ ₹2,500
  });

  it('rejects with the binding control when the caps leave nothing', () => {
    const engine = new RiskEngine();
    const decision = engine.evaluate(
      context({ request: request({ quantity: 100 }) }),
      account({ availableCash: fromRupees(100) }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejections[0]!.code).toBe('INSUFFICIENT_CAPITAL');
  });
});

describe('RiskEngine — halt conditions', () => {
  it('engages the kill switch the moment drawdown breaches', () => {
    const engine = new RiskEngine();
    expect(engine.killSwitch.isEngaged).toBe(false);

    const breaches = engine.checkHaltConditions(
      account({ equity: fromRupees(800_000), peakEquity: fromRupees(1_000_000) }),
      123,
    );

    expect(breaches.map((b) => b.code)).toContain('MAX_DRAWDOWN');
    expect(engine.killSwitch.isEngaged).toBe(true);
    expect(engine.killSwitch.state.since).toBe(123);
  });

  it('does not engage while inside the limits', () => {
    const engine = new RiskEngine();
    const breaches = engine.checkHaltConditions(account(), 1);

    expect(breaches).toHaveLength(0);
    expect(engine.killSwitch.isEngaged).toBe(false);
  });
});

describe('LossStreakBreaker', () => {
  const DAY = 86_400_000;

  it('trips at the configured streak length', () => {
    const breaker = new LossStreakBreaker(4, DAY);
    for (let i = 0; i < 3; i += 1) breaker.record(-100, i);

    expect(breaker.isTripped(3)).toBe(false);
    breaker.record(-100, 4);
    expect(breaker.isTripped(4)).toBe(true);
  });

  it('clears the streak on a winning trade', () => {
    const breaker = new LossStreakBreaker(4, DAY);
    for (let i = 0; i < 3; i += 1) breaker.record(-100, i);
    breaker.record(50, 4);

    expect(breaker.effectiveStreak(4)).toBe(0);
    expect(breaker.isTripped(4)).toBe(false);
  });

  it('releases itself once the cooling-off period elapses', () => {
    // The regression that motivated this class: without a cooldown the breaker
    // trips once and blocks every entry forever, because only a *winning*
    // trade clears a losing streak and no trade can be opened to produce one.
    const breaker = new LossStreakBreaker(4, DAY);
    for (let i = 0; i < 4; i += 1) breaker.record(-100, 1000);

    expect(breaker.isTripped(1000)).toBe(true);
    expect(breaker.isTripped(1000 + DAY - 1)).toBe(true);
    expect(breaker.isTripped(1000 + DAY)).toBe(false);
    expect(breaker.effectiveStreak(1000 + DAY)).toBe(0);
  });

  it('can trip again after releasing', () => {
    const breaker = new LossStreakBreaker(2, DAY);
    breaker.record(-100, 0);
    breaker.record(-100, 0);
    expect(breaker.isTripped(0)).toBe(true);

    expect(breaker.isTripped(DAY)).toBe(false);
    breaker.record(-100, DAY);
    breaker.record(-100, DAY);
    expect(breaker.isTripped(DAY)).toBe(true);
  });

  it('keeps the original trip time while still cooling off', () => {
    const breaker = new LossStreakBreaker(2, DAY);
    breaker.record(-100, 500);
    breaker.record(-100, 500);
    breaker.record(-100, 900);

    expect(breaker.state.trippedAt).toBe(500);
  });
});

describe('KillSwitch', () => {
  it('keeps the first reason and timestamp when re-engaged', () => {
    const killSwitch = new KillSwitch();
    killSwitch.engage('first', 100);
    killSwitch.engage('second', 200);

    expect(killSwitch.state.reason).toBe('first');
    expect(killSwitch.state.since).toBe(100);
  });

  it('clears only on an explicit release', () => {
    const killSwitch = new KillSwitch();
    killSwitch.engage('reason', 1);
    killSwitch.release();

    expect(killSwitch.isEngaged).toBe(false);
  });
});

describe('RiskEngine — configuration', () => {
  it('rejects a nonsensical limit set at construction', () => {
    expect(() => new RiskEngine({ ...DEFAULT_RISK_LIMITS, maxDrawdownFraction: 0 })).toThrow();
    expect(() => new RiskEngine({ ...DEFAULT_RISK_LIMITS, maxOpenPositions: 0 })).toThrow();
  });

  it('rejects invalid quantities outright', () => {
    const engine = new RiskEngine();
    expect(
      engine.evaluate(context({ request: request({ quantity: 0 }) }), account()).rejections[0]!.code,
    ).toBe('INVALID_QUANTITY');
    expect(
      engine.evaluate(context({ request: request({ quantity: 1.5 }) }), account()).rejections[0]!
        .code,
    ).toBe('INVALID_QUANTITY');
  });
});
