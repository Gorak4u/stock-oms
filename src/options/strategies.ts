/**
 * Defined-risk options structures.
 *
 * Every structure here has a bounded worst case that can be computed before
 * the trade is placed. Naked short options are deliberately absent: their loss
 * is unbounded, which the risk engine cannot size against — a stop-distance
 * position sizer needs a worst case, and "infinite" is not one.
 *
 * A structure is expressed as a set of legs. The platform's execution layer
 * treats each leg as an ordinary order, so nothing below needs special
 * handling downstream.
 */

import { fromPaise, type Paise } from '../domain/money';
import type { OptionRight, Side, Timestamp } from '../domain/types';
import { greeks, priceOption, type Greeks, type OptionInputs } from './pricing';

export interface OptionLeg {
  readonly symbol: string;
  readonly right: OptionRight;
  readonly strike: Paise;
  readonly side: Side;
  /** Number of lots. Multiplied by `lotSize` for the actual quantity. */
  readonly lots: number;
  readonly expiry: Timestamp;
}

export type StructureKind =
  | 'BULL_CALL_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'LONG_STRADDLE'
  | 'LONG_STRANGLE'
  | 'IRON_CONDOR';

export interface OptionStructure {
  readonly kind: StructureKind;
  readonly underlying: string;
  readonly legs: readonly OptionLeg[];
  readonly lotSize: number;
}

export interface StructureRisk {
  /** Cost to open. Positive is a debit paid, negative is a credit received. */
  readonly netDebit: Paise;
  /** Best case at expiry, before costs. */
  readonly maxProfit: Paise;
  /** Worst case at expiry, before costs. Always finite here. */
  readonly maxLoss: Paise;
  /** Underlying prices at which the structure breaks even at expiry. */
  readonly breakEvens: readonly Paise[];
  readonly greeks: Greeks;
}

/** Value of one leg at expiry for a given settlement price. */
function legPayoffAtExpiry(leg: OptionLeg, settlement: Paise, lotSize: number): number {
  const intrinsic =
    leg.right === 'CE'
      ? Math.max(0, settlement - leg.strike)
      : Math.max(0, leg.strike - settlement);

  const direction = leg.side === 'BUY' ? 1 : -1;
  return direction * intrinsic * leg.lots * lotSize;
}

/** Payoff of the whole structure at a settlement price, excluding the opening cost. */
export function payoffAtExpiry(structure: OptionStructure, settlement: Paise): Paise {
  let total = 0;
  for (const leg of structure.legs) {
    total += legPayoffAtExpiry(leg, settlement, structure.lotSize);
  }
  return fromPaise(Math.round(total));
}

export interface PricingContext {
  readonly spot: Paise;
  readonly rate: number;
  readonly volatility: number;
  readonly now: Timestamp;
  readonly dividendYield?: number;
}

function legInputs(leg: OptionLeg, context: PricingContext): OptionInputs {
  return {
    spot: context.spot,
    strike: leg.strike,
    timeToExpiry: Math.max(0, (leg.expiry - context.now) / (365 * 86_400_000)),
    rate: context.rate,
    volatility: context.volatility,
    right: leg.right,
    ...(context.dividendYield !== undefined ? { dividendYield: context.dividendYield } : {}),
  };
}

/** Net cost to open: debits positive, credits negative. */
export function netDebit(structure: OptionStructure, context: PricingContext): Paise {
  let total = 0;
  for (const leg of structure.legs) {
    const premium = priceOption(legInputs(leg, context));
    const direction = leg.side === 'BUY' ? 1 : -1;
    total += direction * premium * leg.lots * structure.lotSize;
  }
  return fromPaise(Math.round(total));
}

/** Position greeks: each leg's greeks, signed and scaled by size. */
export function structureGreeks(structure: OptionStructure, context: PricingContext): Greeks {
  let delta = 0, gamma = 0, vega = 0, theta = 0, rho = 0;

  for (const leg of structure.legs) {
    const g = greeks(legInputs(leg, context));
    const scale = (leg.side === 'BUY' ? 1 : -1) * leg.lots * structure.lotSize;
    delta += g.delta * scale;
    gamma += g.gamma * scale;
    vega += g.vega * scale;
    theta += g.theta * scale;
    rho += g.rho * scale;
  }

  return { delta, gamma, vega, theta, rho };
}

/**
 * Full risk profile.
 *
 * Max profit and loss are found by scanning the payoff across the strikes and
 * beyond them, rather than by a closed form per structure kind. One scan is
 * correct for every combination of legs — including ones the named
 * constructors do not produce — where five hand-derived formulae would each be
 * a place to get a sign wrong.
 */
export function analyseStructure(
  structure: OptionStructure,
  context: PricingContext,
): StructureRisk {
  const cost = netDebit(structure, context);
  const strikes = structure.legs.map((leg) => leg.strike).sort((a, b) => a - b);
  const lowest = strikes[0]!;
  const highest = strikes[strikes.length - 1]!;
  const width = Math.max(highest - lowest, lowest * 0.2, 1);

  // Sample every strike, midpoints between them, and points far outside the
  // range so unbounded structures reveal themselves.
  const samples = new Set<number>([
    Math.max(1, lowest - width * 2),
    Math.max(1, lowest - width),
    ...strikes,
    highest + width,
    highest + width * 2,
  ]);
  for (let i = 1; i < strikes.length; i += 1) {
    samples.add(Math.round((strikes[i - 1]! + strikes[i]!) / 2));
  }

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const settlement of samples) {
    const net = payoffAtExpiry(structure, settlement as Paise) - cost;
    if (net > maxProfit) maxProfit = net;
    if (net < maxLoss) maxLoss = net;
  }

  return {
    netDebit: cost,
    maxProfit: fromPaise(Math.round(maxProfit)),
    maxLoss: fromPaise(Math.round(maxLoss)),
    breakEvens: findBreakEvens(structure, cost),
    greeks: structureGreeks(structure, context),
  };
}

/**
 * Break-even settlement prices.
 *
 * The payoff is piecewise linear with kinks only at strikes, so scanning
 * between adjacent strikes and bisecting any sign change finds every crossing
 * exactly — no root-finding heuristics needed.
 */
function findBreakEvens(structure: OptionStructure, cost: Paise): Paise[] {
  const strikes = [...new Set(structure.legs.map((leg) => leg.strike))].sort((a, b) => a - b);
  const lowest = strikes[0]!;
  const highest = strikes[strikes.length - 1]!;
  const width = Math.max(highest - lowest, lowest * 0.2, 1);

  const bounds: number[] = [Math.max(1, lowest - width), ...strikes, highest + width];
  const netAt = (s: number): number => payoffAtExpiry(structure, s as Paise) - cost;

  const found: Paise[] = [];

  for (let i = 1; i < bounds.length; i += 1) {
    let low = bounds[i - 1]!;
    let high = bounds[i]!;
    let fLow = netAt(low);
    const fHigh = netAt(high);

    if (fLow === 0) found.push(fromPaise(low));
    if (fLow * fHigh > 0) continue;

    for (let iteration = 0; iteration < 60 && high - low > 1; iteration += 1) {
      const mid = Math.round((low + high) / 2);
      const fMid = netAt(mid);
      if (fLow * fMid <= 0) {
        high = mid;
      } else {
        low = mid;
        fLow = fMid;
      }
    }
    found.push(fromPaise(high));
  }

  return [...new Set(found)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function leg(
  underlying: string, right: OptionRight, strike: Paise, side: Side, lots: number, expiry: Timestamp,
): OptionLeg {
  return { symbol: `${underlying}${strike}${right}`, right, strike, side, lots, expiry };
}

export interface SpreadParams {
  readonly underlying: string;
  readonly lotSize: number;
  readonly lots: number;
  readonly expiry: Timestamp;
}

/** Long the lower call, short the higher. Bullish, debit, bounded both ways. */
export function bullCallSpread(
  params: SpreadParams, lowerStrike: Paise, upperStrike: Paise,
): OptionStructure {
  if (upperStrike <= lowerStrike) {
    throw new Error('bull call spread requires upperStrike above lowerStrike');
  }
  const { underlying, lots, expiry } = params;
  return {
    kind: 'BULL_CALL_SPREAD',
    underlying,
    lotSize: params.lotSize,
    legs: [
      leg(underlying, 'CE', lowerStrike, 'BUY', lots, expiry),
      leg(underlying, 'CE', upperStrike, 'SELL', lots, expiry),
    ],
  };
}

/** Long the higher put, short the lower. Bearish, debit, bounded both ways. */
export function bearPutSpread(
  params: SpreadParams, lowerStrike: Paise, upperStrike: Paise,
): OptionStructure {
  if (upperStrike <= lowerStrike) {
    throw new Error('bear put spread requires upperStrike above lowerStrike');
  }
  const { underlying, lots, expiry } = params;
  return {
    kind: 'BEAR_PUT_SPREAD',
    underlying,
    lotSize: params.lotSize,
    legs: [
      leg(underlying, 'PE', upperStrike, 'BUY', lots, expiry),
      leg(underlying, 'PE', lowerStrike, 'SELL', lots, expiry),
    ],
  };
}

/** Long call and put at the same strike. Long volatility; loss capped at the debit. */
export function longStraddle(params: SpreadParams, strike: Paise): OptionStructure {
  const { underlying, lots, expiry } = params;
  return {
    kind: 'LONG_STRADDLE',
    underlying,
    lotSize: params.lotSize,
    legs: [
      leg(underlying, 'CE', strike, 'BUY', lots, expiry),
      leg(underlying, 'PE', strike, 'BUY', lots, expiry),
    ],
  };
}

/** Long out-of-the-money call and put. Cheaper than a straddle, needs a bigger move. */
export function longStrangle(
  params: SpreadParams, putStrike: Paise, callStrike: Paise,
): OptionStructure {
  if (callStrike <= putStrike) {
    throw new Error('strangle requires callStrike above putStrike');
  }
  const { underlying, lots, expiry } = params;
  return {
    kind: 'LONG_STRANGLE',
    underlying,
    lotSize: params.lotSize,
    legs: [
      leg(underlying, 'CE', callStrike, 'BUY', lots, expiry),
      leg(underlying, 'PE', putStrike, 'BUY', lots, expiry),
    ],
  };
}

/**
 * Iron condor — short strangle with long wings.
 *
 * Collects premium while the underlying stays inside the short strikes. The
 * wings are what make it tradeable here: without them the short strangle has
 * unbounded loss and the risk engine could not size it.
 */
export function ironCondor(
  params: SpreadParams,
  longPut: Paise, shortPut: Paise, shortCall: Paise, longCall: Paise,
): OptionStructure {
  if (!(longPut < shortPut && shortPut < shortCall && shortCall < longCall)) {
    throw new Error('iron condor strikes must be ordered longPut < shortPut < shortCall < longCall');
  }
  const { underlying, lots, expiry } = params;
  return {
    kind: 'IRON_CONDOR',
    underlying,
    lotSize: params.lotSize,
    legs: [
      leg(underlying, 'PE', longPut, 'BUY', lots, expiry),
      leg(underlying, 'PE', shortPut, 'SELL', lots, expiry),
      leg(underlying, 'CE', shortCall, 'SELL', lots, expiry),
      leg(underlying, 'CE', longCall, 'BUY', lots, expiry),
    ],
  };
}
