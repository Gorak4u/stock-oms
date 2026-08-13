/**
 * Position sizing.
 *
 * Size is derived from the distance to the stop, not from a fixed rupee
 * amount or a fixed share count. Risking 1% of equity per trade means the
 * *loss when the stop is hit* is 1% of equity — so a wide-stop trade in a
 * volatile name gets a small position and a tight-stop trade gets a larger
 * one, and the account experiences both as the same risk.
 */

import { divFloor, mulRate, type Paise } from '../domain/money';

export interface SizingInput {
  readonly equity: Paise;
  readonly entryPrice: Paise;
  /** Protective stop. Must sit on the losing side of the entry. */
  readonly stopLoss: Paise;
  /** Fraction of equity to lose if the stop is hit. */
  readonly riskFraction: number;
  /** Cap on position value as a fraction of equity. */
  readonly maxPositionFraction: number;
  /** Cash actually available to pay for the position. */
  readonly availableCash: Paise;
  /** Shares per lot; the result is always a whole multiple. */
  readonly lotSize: number;
  /** Leverage the product allows (intraday MIS typically > 1). */
  readonly leverage?: number;
}

export interface SizingResult {
  readonly quantity: number;
  /** Which cap actually bound the size — useful when a size looks surprising. */
  readonly boundBy: 'RISK' | 'POSITION_CAP' | 'CASH' | 'NONE';
  /** Cash committed at `entryPrice`. */
  readonly notional: Paise;
  /** Loss if the stop fills exactly, before costs. */
  readonly riskAmount: Paise;
}

export class SizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SizingError';
  }
}

/**
 * Computes the largest quantity that satisfies every cap simultaneously.
 *
 * Returns zero rather than throwing when the caps admit nothing — "this trade
 * is too big to take safely" is a normal outcome, not an error.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const {
    equity,
    entryPrice,
    stopLoss,
    riskFraction,
    maxPositionFraction,
    availableCash,
    lotSize,
    leverage = 1,
  } = input;

  if (entryPrice <= 0) throw new SizingError(`entryPrice must be positive, got ${entryPrice}`);
  if (lotSize < 1 || !Number.isInteger(lotSize)) {
    throw new SizingError(`lotSize must be a positive integer, got ${lotSize}`);
  }
  if (riskFraction <= 0 || riskFraction > 1) {
    throw new SizingError(`riskFraction must be in (0, 1], got ${riskFraction}`);
  }
  if (leverage <= 0) throw new SizingError(`leverage must be positive, got ${leverage}`);

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) {
    throw new SizingError('stopLoss must differ from entryPrice — zero stop distance');
  }

  if (equity <= 0) {
    return { quantity: 0, boundBy: 'RISK', notional: 0 as Paise, riskAmount: 0 as Paise };
  }

  // Cap 1 — risk budget: how many shares before the stop costs more than allowed.
  const riskBudget = mulRate(equity, riskFraction);
  const byRisk = Math.floor(riskBudget / stopDistance);

  // Cap 2 — position value: how many shares fit in the per-position notional cap.
  const positionCap = mulRate(equity, maxPositionFraction);
  const byPositionCap = divFloor(positionCap, entryPrice);

  // Cap 3 — cash: what the account can actually pay for, after leverage.
  const buyingPower = mulRate(availableCash, leverage);
  const byCash = divFloor(buyingPower, entryPrice);

  const raw = Math.min(byRisk, byPositionCap, byCash);
  const quantity = Math.floor(Math.max(0, raw) / lotSize) * lotSize;

  let boundBy: SizingResult['boundBy'] = 'NONE';
  if (quantity > 0) {
    if (raw === byRisk) boundBy = 'RISK';
    else if (raw === byPositionCap) boundBy = 'POSITION_CAP';
    else boundBy = 'CASH';
  } else {
    // Report the tightest cap even when it rounded away to nothing.
    const tightest = Math.min(byRisk, byPositionCap, byCash);
    boundBy = tightest === byRisk ? 'RISK' : tightest === byPositionCap ? 'POSITION_CAP' : 'CASH';
  }

  return {
    quantity,
    boundBy,
    notional: (quantity * entryPrice) as Paise,
    riskAmount: (quantity * stopDistance) as Paise,
  };
}

/**
 * Stop price a fixed number of ATRs away from entry.
 *
 * Quoting stops in volatility units rather than percentages keeps the
 * probability of being stopped out by noise roughly constant across
 * instruments.
 */
export function atrStopLoss(
  entryPrice: Paise,
  atrValue: number,
  direction: 'LONG' | 'SHORT',
  multiplier = 2,
): Paise {
  if (atrValue <= 0) throw new SizingError(`atr must be positive, got ${atrValue}`);
  const distance = Math.round(atrValue * multiplier);
  const stop = direction === 'LONG' ? entryPrice - distance : entryPrice + distance;
  // A stop at or below zero is meaningless; floor it one paise above.
  return Math.max(1, stop) as Paise;
}

/**
 * Ratchets a trailing stop.
 *
 * A trailing stop may only ever move in the direction of profit. Letting it
 * loosen when price retraces would convert a protective stop into an
 * open-ended loss, which is precisely the failure it exists to prevent.
 */
export function trailStop(
  currentStop: Paise,
  candidateStop: Paise,
  direction: 'LONG' | 'SHORT',
): Paise {
  if (direction === 'LONG') {
    return candidateStop > currentStop ? candidateStop : currentStop;
  }
  return candidateStop < currentStop ? candidateStop : currentStop;
}

/** True when price has reached or passed the stop and the position must be closed. */
export function isStopTriggered(
  lastPrice: Paise,
  stop: Paise,
  direction: 'LONG' | 'SHORT',
): boolean {
  return direction === 'LONG' ? lastPrice <= stop : lastPrice >= stop;
}
