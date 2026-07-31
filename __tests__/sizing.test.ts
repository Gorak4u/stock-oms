import { fromRupees, type Paise } from '../src/domain/money';
import {
  atrStopLoss,
  isStopTriggered,
  sizePosition,
  SizingError,
  trailStop,
} from '../src/risk/positionSizing';

const EQUITY = fromRupees(1_000_000);

function input(overrides: Partial<Parameters<typeof sizePosition>[0]> = {}) {
  return {
    equity: EQUITY,
    entryPrice: fromRupees(1000),
    stopLoss: fromRupees(980),
    riskFraction: 0.01,
    maxPositionFraction: 1,
    availableCash: fromRupees(10_000_000),
    lotSize: 1,
    ...overrides,
  };
}

describe('sizePosition', () => {
  it('sizes so that hitting the stop costs exactly the risk budget', () => {
    // 1% of ₹10,00,000 = ₹10,000 risk ÷ ₹20 stop distance = 500 shares.
    const result = sizePosition(input());

    expect(result.quantity).toBe(500);
    expect(result.riskAmount).toBe(fromRupees(10_000));
    expect(result.boundBy).toBe('RISK');
  });

  it('gives a wider stop a smaller position, holding risk constant', () => {
    const tight = sizePosition(input({ stopLoss: fromRupees(990) }));
    const wide = sizePosition(input({ stopLoss: fromRupees(950) }));

    expect(tight.quantity).toBe(1000);
    expect(wide.quantity).toBe(200);
    // Both risk the same ₹10,000.
    expect(tight.riskAmount).toBe(wide.riskAmount);
  });

  it('sizes a short from the distance up to its stop', () => {
    const result = sizePosition(input({ stopLoss: fromRupees(1020) }));
    expect(result.quantity).toBe(500);
  });

  it('is capped by the per-position notional limit', () => {
    // 10% of ₹10,00,000 = ₹1,00,000 ÷ ₹1,000 = 100 shares.
    const result = sizePosition(input({ maxPositionFraction: 0.1 }));

    expect(result.quantity).toBe(100);
    expect(result.boundBy).toBe('POSITION_CAP');
  });

  it('is capped by available cash', () => {
    const result = sizePosition(input({ availableCash: fromRupees(50_000) }));

    expect(result.quantity).toBe(50);
    expect(result.boundBy).toBe('CASH');
  });

  it('lets leverage extend buying power', () => {
    const result = sizePosition(input({ availableCash: fromRupees(50_000), leverage: 5 }));
    expect(result.quantity).toBe(250);
  });

  it('rounds down to a whole number of lots', () => {
    const result = sizePosition(input({ lotSize: 75 }));
    // 500 shares → 6 lots of 75 = 450.
    expect(result.quantity).toBe(450);
    expect(result.quantity % 75).toBe(0);
  });

  it('returns zero rather than a partial lot it cannot fill', () => {
    const result = sizePosition(input({ lotSize: 1000 }));
    expect(result.quantity).toBe(0);
  });

  it('returns zero on non-positive equity instead of a negative size', () => {
    expect(sizePosition(input({ equity: fromRupees(-1000) })).quantity).toBe(0);
    expect(sizePosition(input({ equity: 0 as Paise })).quantity).toBe(0);
  });

  it('never sizes above what the account can pay for', () => {
    const result = sizePosition(
      input({ riskFraction: 1, stopLoss: fromRupees(999), availableCash: fromRupees(5_000) }),
    );
    expect(result.notional).toBeLessThanOrEqual(fromRupees(5_000));
  });

  it('rejects a zero stop distance rather than dividing by zero', () => {
    expect(() => sizePosition(input({ stopLoss: fromRupees(1000) }))).toThrow(SizingError);
  });

  it('rejects invalid parameters', () => {
    expect(() => sizePosition(input({ entryPrice: 0 as Paise }))).toThrow(SizingError);
    expect(() => sizePosition(input({ lotSize: 0 }))).toThrow(SizingError);
    expect(() => sizePosition(input({ riskFraction: 0 }))).toThrow(SizingError);
    expect(() => sizePosition(input({ riskFraction: 1.5 }))).toThrow(SizingError);
    expect(() => sizePosition(input({ leverage: 0 }))).toThrow(SizingError);
  });
});

describe('atrStopLoss', () => {
  it('places the stop below entry for a long and above it for a short', () => {
    expect(atrStopLoss(fromRupees(1000), 1000, 'LONG', 2)).toBe(fromRupees(980));
    expect(atrStopLoss(fromRupees(1000), 1000, 'SHORT', 2)).toBe(fromRupees(1020));
  });

  it('never returns a stop at or below zero', () => {
    expect(atrStopLoss(fromRupees(10), 100_000, 'LONG', 2)).toBe(1);
  });

  it('rejects a non-positive ATR', () => {
    expect(() => atrStopLoss(fromRupees(1000), 0, 'LONG')).toThrow(SizingError);
  });
});

describe('trailStop', () => {
  it('ratchets a long stop up but never back down', () => {
    expect(trailStop(fromRupees(980), fromRupees(990), 'LONG')).toBe(fromRupees(990));
    expect(trailStop(fromRupees(990), fromRupees(980), 'LONG')).toBe(fromRupees(990));
  });

  it('ratchets a short stop down but never back up', () => {
    expect(trailStop(fromRupees(1020), fromRupees(1010), 'SHORT')).toBe(fromRupees(1010));
    expect(trailStop(fromRupees(1010), fromRupees(1020), 'SHORT')).toBe(fromRupees(1010));
  });

  it('only ever moves in the direction of profit across a whole path', () => {
    const path = [1010, 1005, 1030, 1020, 1050, 1040];
    let stop = fromRupees(980);
    let previous = stop;

    for (const price of path) {
      stop = trailStop(stop, fromRupees(price - 20), 'LONG');
      expect(stop).toBeGreaterThanOrEqual(previous);
      previous = stop;
    }

    expect(stop).toBe(fromRupees(1030));
  });
});

describe('isStopTriggered', () => {
  it('triggers a long stop at or below the level', () => {
    expect(isStopTriggered(fromRupees(980), fromRupees(980), 'LONG')).toBe(true);
    expect(isStopTriggered(fromRupees(979), fromRupees(980), 'LONG')).toBe(true);
    expect(isStopTriggered(fromRupees(981), fromRupees(980), 'LONG')).toBe(false);
  });

  it('triggers a short stop at or above the level', () => {
    expect(isStopTriggered(fromRupees(1020), fromRupees(1020), 'SHORT')).toBe(true);
    expect(isStopTriggered(fromRupees(1021), fromRupees(1020), 'SHORT')).toBe(true);
    expect(isStopTriggered(fromRupees(1019), fromRupees(1020), 'SHORT')).toBe(false);
  });
});
