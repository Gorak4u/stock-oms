import { fromRupees, toRupees, type Paise } from '../src/domain/money';
import {
  europeanLowerBound,
  greeks,
  impliedVolatility,
  intrinsicValue,
  normalCdf,
  priceOption,
  yearsBetween,
  type OptionInputs,
} from '../src/options/pricing';
import {
  analyseStructure,
  bearPutSpread,
  bullCallSpread,
  ironCondor,
  longStraddle,
  longStrangle,
  netDebit,
  payoffAtExpiry,
  structureGreeks,
  type PricingContext,
} from '../src/options/strategies';

const BASE: OptionInputs = {
  spot: fromRupees(22_000),
  strike: fromRupees(22_000),
  timeToExpiry: 30 / 365,
  rate: 0.065,
  volatility: 0.15,
  right: 'CE',
};

describe('normalCdf', () => {
  it('matches the published values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 5);
  });

  it('is symmetric about zero', () => {
    for (const x of [0.3, 1.1, 2.5, 3.7]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
  });

  it('saturates without going out of bounds', () => {
    expect(normalCdf(40)).toBeLessThanOrEqual(1);
    expect(normalCdf(-40)).toBeGreaterThanOrEqual(0);
  });
});

describe('priceOption', () => {
  it('satisfies put-call parity', () => {
    // C − P = S·e^(−qT) − K·e^(−rT). Parity is model-free, so a violation
    // means the implementation is wrong, not that the model is a poor fit.
    const call = priceOption({ ...BASE, right: 'CE' });
    const put = priceOption({ ...BASE, right: 'PE' });

    const expected =
      BASE.spot * Math.exp(-0 * BASE.timeToExpiry) -
      BASE.strike * Math.exp(-BASE.rate * BASE.timeToExpiry);

    expect(call - put).toBeCloseTo(expected, -2); // within a paise or two
  });

  it('respects the no-arbitrage bound for both rights', () => {
    // A call on a non-dividend-paying underlying is worth at least its
    // intrinsic value. A European put is not — it is bounded by the
    // *discounted* strike, and deep in the money trades below K − S.
    const call = { ...BASE, spot: fromRupees(23_000) };
    const itmCall = priceOption(call);
    expect(itmCall).toBeGreaterThanOrEqual(intrinsicValue(call.spot, call.strike, 'CE'));

    const put = { ...BASE, spot: fromRupees(21_000), right: 'PE' as const };
    const { volatility: _omit, ...putBounds } = put;
    expect(priceOption(put)).toBeGreaterThanOrEqual(europeanLowerBound(putBounds));
  });

  it('returns exactly the intrinsic value at expiry', () => {
    expect(priceOption({ ...BASE, spot: fromRupees(22_500), timeToExpiry: 0 })).toBe(
      fromRupees(500),
    );
    expect(priceOption({ ...BASE, spot: fromRupees(21_500), timeToExpiry: 0 })).toBe(0);
    expect(
      priceOption({ ...BASE, spot: fromRupees(21_500), timeToExpiry: 0, right: 'PE' }),
    ).toBe(fromRupees(500));
  });

  it('rises with volatility for both calls and puts', () => {
    const low = priceOption({ ...BASE, volatility: 0.1 });
    const high = priceOption({ ...BASE, volatility: 0.3 });
    expect(high).toBeGreaterThan(low);

    const lowPut = priceOption({ ...BASE, volatility: 0.1, right: 'PE' });
    const highPut = priceOption({ ...BASE, volatility: 0.3, right: 'PE' });
    expect(highPut).toBeGreaterThan(lowPut);
  });

  it('rises with time to expiry', () => {
    const near = priceOption({ ...BASE, timeToExpiry: 7 / 365 });
    const far = priceOption({ ...BASE, timeToExpiry: 90 / 365 });
    expect(far).toBeGreaterThan(near);
  });

  it('is monotonic in spot — calls up, puts down', () => {
    let previousCall = -1;
    let previousPut = Infinity;
    for (let spot = 20_000; spot <= 24_000; spot += 500) {
      const call = priceOption({ ...BASE, spot: fromRupees(spot) });
      const put = priceOption({ ...BASE, spot: fromRupees(spot), right: 'PE' });
      expect(call).toBeGreaterThanOrEqual(previousCall);
      expect(put).toBeLessThanOrEqual(previousPut);
      previousCall = call;
      previousPut = put;
    }
  });

  it('is never negative deep out of the money', () => {
    expect(priceOption({ ...BASE, spot: fromRupees(5_000) })).toBeGreaterThanOrEqual(0);
    expect(priceOption({ ...BASE, spot: fromRupees(90_000), right: 'PE' })).toBeGreaterThanOrEqual(0);
  });

  it('rejects impossible inputs', () => {
    expect(() => priceOption({ ...BASE, spot: 0 as Paise })).toThrow();
    expect(() => priceOption({ ...BASE, strike: 0 as Paise })).toThrow();
    expect(() => priceOption({ ...BASE, timeToExpiry: -1 })).toThrow();
    expect(() => priceOption({ ...BASE, volatility: -0.1 })).toThrow();
  });
});

describe('greeks', () => {
  it('gives an at-the-money call a delta slightly above 0.5', () => {
    // Not exactly 0.5: with a positive risk-free rate the forward sits above
    // spot, so an at-the-money call is marginally in the money against the
    // forward. ~0.557 here for 30 days at 6.5% and 15% vol.
    const call = greeks(BASE).delta;
    expect(call).toBeGreaterThan(0.5);
    expect(call).toBeLessThan(0.62);

    const put = greeks({ ...BASE, right: 'PE' }).delta;
    expect(put).toBeLessThan(-0.38);
    expect(put).toBeGreaterThan(-0.5);
  });

  it('satisfies the delta parity relation', () => {
    // For a non-dividend-paying underlying, callDelta − putDelta = 1.
    const call = greeks(BASE).delta;
    const put = greeks({ ...BASE, right: 'PE' }).delta;
    expect(call - put).toBeCloseTo(1, 4);
  });

  it('saturates delta deep in and out of the money', () => {
    expect(greeks({ ...BASE, spot: fromRupees(40_000) }).delta).toBeCloseTo(1, 2);
    expect(greeks({ ...BASE, spot: fromRupees(8_000) }).delta).toBeCloseTo(0, 2);
  });

  it('matches a numerical derivative of price for delta', () => {
    // Delta is ∂V/∂S; bumping spot by ₹1 must move the price by ~delta rupees.
    const bump = fromRupees(1);
    const base = priceOption(BASE);
    const up = priceOption({ ...BASE, spot: (BASE.spot + bump) as Paise });
    const numerical = toRupees((up - base) as Paise);

    expect(greeks(BASE).delta).toBeCloseTo(numerical, 2);
  });

  it('matches a numerical derivative for vega, in rupees per vol point', () => {
    const base = priceOption(BASE);
    const up = priceOption({ ...BASE, volatility: BASE.volatility + 0.01 });
    const numerical = toRupees((up - base) as Paise);

    expect(greeks(BASE).vega).toBeCloseTo(numerical, 1);
  });

  it('matches a numerical derivative for theta, in rupees per day', () => {
    const base = priceOption(BASE);
    const later = priceOption({ ...BASE, timeToExpiry: BASE.timeToExpiry - 1 / 365 });
    const numerical = toRupees((later - base) as Paise);

    expect(greeks(BASE).theta).toBeCloseTo(numerical, 0);
  });

  it('gives long options positive gamma and negative theta', () => {
    const g = greeks(BASE);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(g.vega).toBeGreaterThan(0);
  });

  it('peaks gamma at the money', () => {
    const atm = greeks(BASE).gamma;
    expect(atm).toBeGreaterThan(greeks({ ...BASE, spot: fromRupees(25_000) }).gamma);
    expect(atm).toBeGreaterThan(greeks({ ...BASE, spot: fromRupees(19_000) }).gamma);
  });

  it('collapses to a stock position at expiry', () => {
    const itm = greeks({ ...BASE, spot: fromRupees(23_000), timeToExpiry: 0 });
    expect(itm.delta).toBe(1);
    expect(itm.gamma).toBe(0);
    expect(itm.theta).toBe(0);

    const otm = greeks({ ...BASE, spot: fromRupees(21_000), timeToExpiry: 0 });
    expect(otm.delta).toBe(0);
  });

  it('gives calls positive rho and puts negative rho', () => {
    expect(greeks(BASE).rho).toBeGreaterThan(0);
    expect(greeks({ ...BASE, right: 'PE' }).rho).toBeLessThan(0);
  });
});

describe('impliedVolatility', () => {
  it('recovers the volatility used to generate a price', () => {
    for (const volatility of [0.08, 0.15, 0.28, 0.45]) {
      const price = priceOption({ ...BASE, volatility });
      const { volatility: _omit, ...inputs } = { ...BASE, volatility };
      expect(impliedVolatility(price, inputs)).toBeCloseTo(volatility, 2);
    }
  });

  it('recovers it for puts and away-from-the-money strikes', () => {
    const inputs = { ...BASE, spot: fromRupees(21_000), right: 'PE' as const };
    const { volatility: _omit, ...rest } = inputs;
    const price = priceOption(inputs);
    expect(impliedVolatility(price, rest)).toBeCloseTo(0.15, 2);
  });

  it('returns null below the no-arbitrage bound — a bad quote, not a volatility', () => {
    const { volatility: _omit, ...inputs } = { ...BASE, spot: fromRupees(23_000) };
    expect(impliedVolatility(fromRupees(100), inputs)).toBeNull();
  });

  it('still solves a deep in-the-money European put priced below intrinsic', () => {
    // A European put cannot be exercised early, so deep ITM it is worth about
    // K·e^(−rT) − S — genuinely less than K − S. Guarding against undiscounted
    // intrinsic would reject this perfectly valid quote.
    const inputs = {
      ...BASE, spot: fromRupees(15_000), strike: fromRupees(22_000),
      right: 'PE' as const, timeToExpiry: 1,
    };
    const { volatility: _omit, ...rest } = inputs;
    const price = priceOption(inputs);

    expect(price).toBeLessThan(intrinsicValue(inputs.spot, inputs.strike, 'PE'));
    expect(price).toBeGreaterThan(europeanLowerBound(rest) - 1);
    expect(impliedVolatility(price, rest)).toBeCloseTo(0.15, 2);
  });

  it('returns null for an absurdly high price', () => {
    const { volatility: _omit, ...inputs } = BASE;
    expect(impliedVolatility(fromRupees(50_000), inputs)).toBeNull();
  });

  it('returns null at expiry', () => {
    const { volatility: _omit, ...inputs } = { ...BASE, timeToExpiry: 0 };
    expect(impliedVolatility(fromRupees(100), inputs)).toBeNull();
  });
});

describe('yearsBetween', () => {
  it('converts a 365-day gap to one year', () => {
    expect(yearsBetween(0, 365 * 86_400_000)).toBeCloseTo(1, 10);
  });

  it('floors at zero for an expired option', () => {
    expect(yearsBetween(1000, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

const NIFTY = { underlying: 'NIFTY', lotSize: 50, lots: 1, expiry: 30 * 86_400_000 };
const CONTEXT: PricingContext = {
  spot: fromRupees(22_000),
  rate: 0.065,
  volatility: 0.15,
  now: 0,
};

describe('bullCallSpread', () => {
  const spread = bullCallSpread(NIFTY, fromRupees(22_000), fromRupees(22_500));

  it('is a debit — the bought call costs more than the sold one', () => {
    expect(netDebit(spread, CONTEXT)).toBeGreaterThan(0);
  });

  it('caps profit at the strike width less the debit', () => {
    const risk = analyseStructure(spread, CONTEXT);
    const width = fromRupees(500) * NIFTY.lotSize;
    expect(risk.maxProfit).toBeCloseTo(width - risk.netDebit, -2);
  });

  it('caps loss at the debit paid', () => {
    const risk = analyseStructure(spread, CONTEXT);
    expect(risk.maxLoss).toBeCloseTo(-risk.netDebit, -2);
  });

  it('has exactly one break-even, between the strikes', () => {
    const risk = analyseStructure(spread, CONTEXT);
    expect(risk.breakEvens).toHaveLength(1);
    expect(risk.breakEvens[0]!).toBeGreaterThan(fromRupees(22_000));
    expect(risk.breakEvens[0]!).toBeLessThan(fromRupees(22_500));
  });

  it('is net long delta', () => {
    expect(structureGreeks(spread, CONTEXT).delta).toBeGreaterThan(0);
  });

  it('rejects inverted strikes', () => {
    expect(() => bullCallSpread(NIFTY, fromRupees(22_500), fromRupees(22_000))).toThrow();
  });
});

describe('bearPutSpread', () => {
  const spread = bearPutSpread(NIFTY, fromRupees(21_500), fromRupees(22_000));

  it('is a debit with bounded profit and loss', () => {
    const risk = analyseStructure(spread, CONTEXT);
    expect(risk.netDebit).toBeGreaterThan(0);
    expect(risk.maxLoss).toBeCloseTo(-risk.netDebit, -2);
    expect(Number.isFinite(risk.maxProfit)).toBe(true);
  });

  it('is net short delta', () => {
    expect(structureGreeks(spread, CONTEXT).delta).toBeLessThan(0);
  });
});

describe('longStraddle', () => {
  const straddle = longStraddle(NIFTY, fromRupees(22_000));

  it('loses the full debit if the underlying does not move', () => {
    const risk = analyseStructure(straddle, CONTEXT);
    const atExpiry = payoffAtExpiry(straddle, fromRupees(22_000)) - risk.netDebit;
    expect(atExpiry).toBeCloseTo(-risk.netDebit, -2);
  });

  it('has two break-evens straddling the strike', () => {
    const risk = analyseStructure(straddle, CONTEXT);
    expect(risk.breakEvens).toHaveLength(2);
    expect(risk.breakEvens[0]!).toBeLessThan(fromRupees(22_000));
    expect(risk.breakEvens[1]!).toBeGreaterThan(fromRupees(22_000));
  });

  it('is long volatility and pays for it in theta', () => {
    const g = structureGreeks(straddle, CONTEXT);
    expect(g.vega).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(g.gamma).toBeGreaterThan(0);
    // Delta is roughly flat at the money.
    expect(Math.abs(g.delta)).toBeLessThan(NIFTY.lotSize * 0.2);
  });
});

describe('longStrangle', () => {
  it('costs less than the equivalent straddle', () => {
    const strangle = longStrangle(NIFTY, fromRupees(21_500), fromRupees(22_500));
    const straddle = longStraddle(NIFTY, fromRupees(22_000));
    expect(netDebit(strangle, CONTEXT)).toBeLessThan(netDebit(straddle, CONTEXT));
  });

  it('rejects a call strike below the put strike', () => {
    expect(() => longStrangle(NIFTY, fromRupees(22_500), fromRupees(21_500))).toThrow();
  });
});

describe('ironCondor', () => {
  const condor = ironCondor(
    NIFTY, fromRupees(21_000), fromRupees(21_500), fromRupees(22_500), fromRupees(23_000),
  );

  it('is a credit — premium is collected up front', () => {
    expect(netDebit(condor, CONTEXT)).toBeLessThan(0);
  });

  it('has a bounded, finite worst case — the reason the wings are there', () => {
    const risk = analyseStructure(condor, CONTEXT);
    expect(Number.isFinite(risk.maxLoss)).toBe(true);
    expect(risk.maxLoss).toBeLessThan(0);

    // Loss is capped by the wing width less the credit received.
    const wing = fromRupees(500) * NIFTY.lotSize;
    expect(Math.abs(risk.maxLoss)).toBeLessThanOrEqual(wing);
  });

  it('makes its maximum between the short strikes', () => {
    const risk = analyseStructure(condor, CONTEXT);
    const inside = payoffAtExpiry(condor, fromRupees(22_000)) - risk.netDebit;
    expect(inside).toBeCloseTo(risk.maxProfit, -2);
    expect(risk.maxProfit).toBeGreaterThan(0);
  });

  it('has two break-evens, inside the wings', () => {
    const risk = analyseStructure(condor, CONTEXT);
    expect(risk.breakEvens).toHaveLength(2);
    expect(risk.breakEvens[0]!).toBeGreaterThan(fromRupees(21_000));
    expect(risk.breakEvens[1]!).toBeLessThan(fromRupees(23_000));
  });

  it('is short volatility and collects theta', () => {
    const g = structureGreeks(condor, CONTEXT);
    expect(g.vega).toBeLessThan(0);
    expect(g.theta).toBeGreaterThan(0);
  });

  it('rejects unordered strikes', () => {
    expect(() =>
      ironCondor(NIFTY, fromRupees(22_000), fromRupees(21_500), fromRupees(22_500), fromRupees(23_000)),
    ).toThrow();
  });
});

describe('payoffAtExpiry', () => {
  it('scales with lot size and lot count', () => {
    const single = bullCallSpread(NIFTY, fromRupees(22_000), fromRupees(22_500));
    const double = bullCallSpread({ ...NIFTY, lots: 2 }, fromRupees(22_000), fromRupees(22_500));

    expect(payoffAtExpiry(double, fromRupees(23_000))).toBe(
      payoffAtExpiry(single, fromRupees(23_000)) * 2,
    );
  });

  it('is zero for a spread finishing below both strikes', () => {
    const spread = bullCallSpread(NIFTY, fromRupees(22_000), fromRupees(22_500));
    expect(payoffAtExpiry(spread, fromRupees(21_000))).toBe(0);
  });
});
