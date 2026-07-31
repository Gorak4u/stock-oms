/**
 * Black-Scholes pricing and greeks for European index options.
 *
 * NSE index options (NIFTY, BANKNIFTY) are European, so Black-Scholes applies
 * directly. Stock options are American and can be exercised early; this model
 * under-prices those, which is why {@link priceOption} is documented as
 * index-only rather than quietly reused.
 *
 * Prices are in paise, rates and volatilities are annualised decimals, and
 * time is in years. Greeks are returned in their conventional units — delta
 * per ₹1 of underlying, vega per volatility *point*, theta per calendar day —
 * because those are the units a trader sizes against, and converting at the
 * call site is where sign and scale errors creep in.
 */

import { fromPaise, type Paise } from '../domain/money';
import type { OptionRight } from '../domain/types';

export interface OptionInputs {
  /** Spot price of the underlying. */
  readonly spot: Paise;
  readonly strike: Paise;
  /** Time to expiry in years. */
  readonly timeToExpiry: number;
  /** Annualised risk-free rate, e.g. 0.065 for 6.5%. */
  readonly rate: number;
  /** Annualised implied volatility, e.g. 0.18 for 18%. */
  readonly volatility: number;
  readonly right: OptionRight;
  /** Continuous dividend yield on the underlying. Zero for most Indian indices. */
  readonly dividendYield?: number;
}

export interface Greeks {
  /** Change in option value per ₹1 move in the underlying. */
  readonly delta: number;
  /** Change in delta per ₹1 move in the underlying. */
  readonly gamma: number;
  /** Change in value per volatility point (1% = 0.01), in rupees. */
  readonly vega: number;
  /** Change in value per calendar day, in rupees. Negative for long options. */
  readonly theta: number;
  /** Change in value per 1% move in the rate, in rupees. */
  readonly rho: number;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/** Standard normal PDF. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26 on `erf`.
 *
 * Accurate to about 1.5e-7 — well inside the bid-ask spread of any option
 * actually tradeable, and far cheaper than a series expansion.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

interface D1D2 {
  readonly d1: number;
  readonly d2: number;
  readonly spot: number;
  readonly strike: number;
  readonly carry: number;
  readonly discount: number;
  readonly sqrtT: number;
}

function terms(inputs: OptionInputs): D1D2 {
  const { timeToExpiry: t, rate, volatility, dividendYield = 0 } = inputs;
  const spot = inputs.spot;
  const strike = inputs.strike;

  if (spot <= 0) throw new PricingError(`spot must be positive, got ${spot}`);
  if (strike <= 0) throw new PricingError(`strike must be positive, got ${strike}`);
  if (t < 0) throw new PricingError(`timeToExpiry must be non-negative, got ${t}`);
  if (volatility < 0) throw new PricingError(`volatility must be non-negative, got ${volatility}`);

  const sqrtT = Math.sqrt(t);
  const carry = Math.exp(-dividendYield * t);
  const discount = Math.exp(-rate * t);

  // At expiry, or with no volatility, d1/d2 are degenerate. Callers get the
  // intrinsic value from `priceOption`; these are placeholders that keep the
  // greeks finite rather than NaN.
  if (t === 0 || volatility === 0) {
    const inTheMoney = spot > strike;
    const big = inTheMoney ? 1e9 : -1e9;
    return { d1: big, d2: big, spot, strike, carry, discount, sqrtT };
  }

  const d1 =
    (Math.log(spot / strike) + (rate - dividendYield + (volatility * volatility) / 2) * t) /
    (volatility * sqrtT);

  return { d1, d2: d1 - volatility * sqrtT, spot, strike, carry, discount, sqrtT };
}

/** Value of the option if it expired right now. */
export function intrinsicValue(spot: Paise, strike: Paise, right: OptionRight): Paise {
  return fromPaise(Math.max(0, right === 'CE' ? spot - strike : strike - spot));
}

/**
 * No-arbitrage lower bound for a European option.
 *
 * Note this is **not** the undiscounted intrinsic value. A European put cannot
 * be exercised early, so a deep in-the-money one is worth roughly
 * `K·e^(−rT) − S` — genuinely *less* than `K − S`, because the strike is only
 * received at expiry. Rejecting quotes below undiscounted intrinsic would
 * therefore throw away perfectly good deep-ITM put prices as "impossible".
 */
export function europeanLowerBound(inputs: Omit<OptionInputs, 'volatility'>): Paise {
  const { spot, strike, timeToExpiry: t, rate, right, dividendYield = 0 } = inputs;
  const carried = spot * Math.exp(-dividendYield * t);
  const discountedStrike = strike * Math.exp(-rate * t);

  return fromPaise(
    Math.max(0, Math.floor(right === 'CE' ? carried - discountedStrike : discountedStrike - carried)),
  );
}

/**
 * Black-Scholes value. **Index (European) options only.**
 *
 * At zero time to expiry the intrinsic value is returned exactly, which is
 * both correct and what settlement pays.
 */
export function priceOption(inputs: OptionInputs): Paise {
  const { timeToExpiry, volatility, right } = inputs;

  if (timeToExpiry === 0 || volatility === 0) {
    return intrinsicValue(inputs.spot, inputs.strike, right);
  }

  const { d1, d2, spot, strike, carry, discount } = terms(inputs);

  const value =
    right === 'CE'
      ? spot * carry * normalCdf(d1) - strike * discount * normalCdf(d2)
      : strike * discount * normalCdf(-d2) - spot * carry * normalCdf(-d1);

  // An option is never worth less than nothing; rounding near expiry can push
  // the formula a fraction below zero.
  return fromPaise(Math.max(0, Math.round(value)));
}

/** Greeks in trader-facing units. See {@link Greeks}. */
export function greeks(inputs: OptionInputs): Greeks {
  const { right, timeToExpiry: t, rate, volatility, dividendYield = 0 } = inputs;

  if (t === 0) {
    // At expiry the option is a position in the underlying or nothing at all.
    const itm =
      right === 'CE' ? inputs.spot > inputs.strike : inputs.spot < inputs.strike;
    const delta = itm ? (right === 'CE' ? 1 : -1) : 0;
    return { delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }

  const { d1, d2, spot, strike, carry, discount, sqrtT } = terms(inputs);
  const pdf = normalPdf(d1);

  // The formulae below are in the units of their inputs: prices are paise, so
  // anything with a price dimension comes out in paise, and anything with a
  // 1/price dimension comes out per paise. Each is converted exactly once, at
  // the end, to the unit the Greeks interface documents.
  const PAISE_PER_RUPEE = 100;

  // Delta is a ratio of two prices — dimensionless, so no conversion.
  const delta = right === 'CE' ? carry * normalCdf(d1) : carry * (normalCdf(d1) - 1);

  // Gamma has dimension 1/price, so in paise it is "delta change per paise".
  // Multiplying by 100 gives delta change per ₹1, which is how it is quoted.
  const gammaPerPaise = volatility === 0 ? 0 : (carry * pdf) / (spot * volatility * sqrtT);
  const gamma = gammaPerPaise * PAISE_PER_RUPEE;

  // Vega: paise per 1.00 of vol. /100 → per vol point, /100 again → rupees.
  const vegaPaisePerUnitVol = spot * carry * pdf * sqrtT;
  const vega = vegaPaisePerUnitVol / 100 / PAISE_PER_RUPEE;

  // Theta: paise per year. 365 calendar days — decay runs over the calendar,
  // not the trading week — then paise → rupees.
  const thetaPaisePerYear =
    right === 'CE'
      ? -(spot * carry * pdf * volatility) / (2 * sqrtT) -
        rate * strike * discount * normalCdf(d2) +
        dividendYield * spot * carry * normalCdf(d1)
      : -(spot * carry * pdf * volatility) / (2 * sqrtT) +
        rate * strike * discount * normalCdf(-d2) -
        dividendYield * spot * carry * normalCdf(-d1);
  const theta = thetaPaisePerYear / 365 / PAISE_PER_RUPEE;

  // Rho: paise per 1.00 of rate. /100 → per 1% move, /100 again → rupees.
  const rhoPaisePerUnitRate =
    right === 'CE'
      ? strike * t * discount * normalCdf(d2)
      : -strike * t * discount * normalCdf(-d2);
  const rho = rhoPaisePerUnitRate / 100 / PAISE_PER_RUPEE;

  return { delta, gamma, vega, theta, rho };
}

/**
 * Implied volatility from a market price, by bisection.
 *
 * Bisection rather than Newton-Raphson: vega collapses toward zero for deep
 * in- and out-of-the-money options, and Newton divides by it. Bisection is
 * slower but cannot diverge, which matters when this runs unattended against
 * whatever the feed prints.
 *
 * Returns `null` when the price is outside the arbitrage bounds — that is a
 * bad quote, not a volatility.
 */
export function impliedVolatility(
  marketPrice: Paise,
  inputs: Omit<OptionInputs, 'volatility'>,
  tolerance = 1e-6,
  maxIterations = 100,
): number | null {
  if (inputs.timeToExpiry <= 0) return null;
  if (marketPrice < europeanLowerBound(inputs)) return null;

  let low = 1e-6;
  let high = 5; // 500% vol — far beyond anything a real quote implies

  const priceAt = (volatility: number): number => priceOption({ ...inputs, volatility });

  if (marketPrice > priceAt(high)) return null;

  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (low + high) / 2;
    const value = priceAt(mid);

    if (Math.abs(value - marketPrice) < 1) return mid; // within one paise
    if (high - low < tolerance) return mid;

    if (value > marketPrice) high = mid;
    else low = mid;
  }

  return (low + high) / 2;
}

/** Years between two epoch timestamps, on a 365-day calendar. */
export function yearsBetween(from: number, to: number): number {
  return Math.max(0, (to - from) / (365 * 86_400_000));
}
