/**
 * Corporate-action adjustment.
 *
 * A 1:10 split shows up in a raw price series as a 90% overnight crash. Every
 * trend, momentum and volatility feature would read that as a signal, so
 * historical prices must be back-adjusted before anything computes on them.
 *
 * Convention: prices *before* the ex-date are adjusted; prices on and after it
 * are already in post-action terms and left alone. This keeps the most recent
 * price equal to the actual traded price, which is what the execution layer
 * and the broker agree on.
 */

import type { Candle, Timestamp } from '../domain/types';
import { fromPaise, mulRate, type Paise } from '../domain/money';

export type CorporateActionKind = 'SPLIT' | 'BONUS' | 'DIVIDEND';

export interface CorporateAction {
  readonly symbol: string;
  readonly kind: CorporateActionKind;
  /** First session on which the stock trades without the entitlement. */
  readonly exDate: Timestamp;
  /**
   * Split — shares after : shares before (a 1:10 split is `ratio = 10`).
   * Bonus — `ratio = (existing + bonus) / existing`; a 1:1 bonus is `2`.
   * Ignored for dividends.
   */
  readonly ratio?: number;
  /** Dividend per share. Ignored for splits and bonuses. */
  readonly amount?: Paise;
}

/**
 * Price multiplier applied to bars before the ex-date.
 *
 * Splits and bonuses both multiply share count by `ratio`, so historical
 * prices divide by it. A dividend removes cash from the stock on the ex-date,
 * so history is scaled by `(close - dividend) / close` against the last cum
 * price.
 */
export function adjustmentFactor(action: CorporateAction, lastCumClose: Paise): number {
  switch (action.kind) {
    case 'SPLIT':
    case 'BONUS': {
      const ratio = action.ratio;
      if (ratio === undefined || ratio <= 0) {
        throw new Error(`${action.kind} on ${action.symbol} requires a positive ratio`);
      }
      return 1 / ratio;
    }
    case 'DIVIDEND': {
      const amount = action.amount;
      if (amount === undefined || amount < 0) {
        throw new Error(`DIVIDEND on ${action.symbol} requires a non-negative amount`);
      }
      if (lastCumClose <= 0) return 1;
      return (lastCumClose - amount) / lastCumClose;
    }
  }
}

/**
 * Back-adjusts a candle series for a set of corporate actions.
 *
 * Actions are applied newest-first so their factors compound correctly: a bar
 * older than two splits must be divided by both.
 *
 * `candles` must be ascending by timestamp. Volume is scaled by the inverse of
 * the price factor for splits and bonuses, keeping traded value continuous.
 */
export function adjustForCorporateActions(
  candles: readonly Candle[],
  actions: readonly CorporateAction[],
): Candle[] {
  if (candles.length === 0 || actions.length === 0) return [...candles];

  const relevant = [...actions]
    .filter((action) => action.symbol === candles[0]!.symbol)
    .sort((a, b) => b.exDate - a.exDate);

  if (relevant.length === 0) return [...candles];

  const adjusted = [...candles];

  for (const action of relevant) {
    const lastCumIndex = findLastIndexBefore(adjusted, action.exDate);
    if (lastCumIndex < 0) continue;

    const factor = adjustmentFactor(action, adjusted[lastCumIndex]!.close);
    if (factor === 1) continue;

    const volumeFactor = action.kind === 'DIVIDEND' ? 1 : 1 / factor;

    for (let i = 0; i <= lastCumIndex; i += 1) {
      const candle = adjusted[i]!;
      adjusted[i] = {
        ...candle,
        open: mulRate(candle.open, factor),
        high: mulRate(candle.high, factor),
        low: mulRate(candle.low, factor),
        close: mulRate(candle.close, factor),
        volume: Math.round(candle.volume * volumeFactor),
      };
    }
  }

  return adjusted;
}

/** Index of the last candle strictly before `exDate`, or -1. Binary search. */
function findLastIndexBefore(candles: readonly Candle[], exDate: Timestamp): number {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.timestamp < exDate) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/**
 * Detects an unexplained overnight gap.
 *
 * Run over an adjusted series, a surviving gap means a corporate action is
 * missing from the reference data — which is a data-quality alert, not a
 * trading signal.
 */
export function findUnexplainedGaps(
  candles: readonly Candle[],
  thresholdFraction = 0.15,
): { timestamp: Timestamp; from: Paise; to: Paise; fraction: number }[] {
  const gaps: { timestamp: Timestamp; from: Paise; to: Paise; fraction: number }[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1]!;
    const current = candles[i]!;
    if (previous.close <= 0) continue;

    const fraction = (current.open - previous.close) / previous.close;
    if (Math.abs(fraction) > thresholdFraction) {
      gaps.push({
        timestamp: current.timestamp,
        from: previous.close,
        to: current.open,
        fraction,
      });
    }
  }

  return gaps;
}

export { fromPaise };
