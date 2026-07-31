/**
 * Trend following — EMA crossover with an ATR-scaled protective stop.
 *
 * Trend systems win by letting a small number of large moves pay for a long
 * tail of small losses, so the exit matters more than the entry. The stop is
 * quoted in ATR rather than percent, which keeps the *risk* per trade constant
 * even as the instrument's volatility changes.
 *
 * A minimum separation between the moving averages is required before a cross
 * counts. Without it, price oscillating around a single level produces a
 * stream of alternating signals that are pure cost.
 */

import type { Candle } from '../domain/types';
import { fromPaise } from '../domain/money';
import { atr, ema, type IndicatorSeries } from '../features/indicators';
import { atrStopLoss } from '../risk/positionSizing';
import {
  closes,
  highs,
  lows,
  positionDirection,
  signal,
  type Strategy,
  type StrategyContext,
} from './types';

export interface TrendFollowingConfig {
  readonly fastPeriod?: number;
  readonly slowPeriod?: number;
  readonly atrPeriod?: number;
  readonly atrStopMultiplier?: number;
  /** Minimum EMA separation, as a fraction of price, before a cross is acted on. */
  readonly minSeparationFraction?: number;
  /** Refuse new entries within this many minutes of the close. */
  readonly noEntryMinutesBeforeClose?: number;
}

interface Prepared {
  readonly fast: IndicatorSeries;
  readonly slow: IndicatorSeries;
  readonly atrValues: IndicatorSeries;
}

export class TrendFollowingStrategy implements Strategy<Prepared> {
  readonly id: string;
  readonly warmupBars: number;

  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly minSeparationFraction: number;
  private readonly noEntryMinutesBeforeClose: number;

  constructor(config: TrendFollowingConfig = {}, id = 'trend-following') {
    this.fastPeriod = config.fastPeriod ?? 20;
    this.slowPeriod = config.slowPeriod ?? 50;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.atrStopMultiplier = config.atrStopMultiplier ?? 2.5;
    this.minSeparationFraction = config.minSeparationFraction ?? 0.002;
    this.noEntryMinutesBeforeClose = config.noEntryMinutesBeforeClose ?? 0;

    if (this.fastPeriod >= this.slowPeriod) {
      throw new Error('trend-following fast period must be shorter than slow period');
    }

    this.id = id;
    this.warmupBars = Math.max(this.slowPeriod, this.atrPeriod) + 1;
  }

  prepare(candles: readonly Candle[]): Prepared {
    const close = closes(candles);
    return {
      fast: ema(close, this.fastPeriod),
      slow: ema(close, this.slowPeriod),
      atrValues: atr({ high: highs(candles), low: lows(candles), close }, this.atrPeriod),
    };
  }

  evaluate(ctx: StrategyContext, prepared: Prepared) {
    const { index } = ctx;
    if (index < this.warmupBars) return null;

    const fast = prepared.fast[index];
    const slow = prepared.slow[index];
    const atrValue = prepared.atrValues[index];
    if (fast == null || slow == null || atrValue == null || atrValue <= 0) return null;

    const candle = ctx.candles[index]!;
    const price = candle.close;
    const separation = Math.abs(fast - slow) / price;
    const held = positionDirection(ctx.position);

    // Exit on the cross back through, regardless of separation — getting out is
    // never gated on a confirmation filter.
    if (held === 'LONG' && fast < slow) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: `EMA${this.fastPeriod} crossed below EMA${this.slowPeriod} — trend over`,
      });
    }
    if (held === 'SHORT' && fast > slow) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: `EMA${this.fastPeriod} crossed above EMA${this.slowPeriod} — trend over`,
      });
    }

    if (held !== 'FLAT') return null;
    if (separation < this.minSeparationFraction) return null;
    if (
      this.noEntryMinutesBeforeClose > 0 &&
      ctx.minutesToClose > 0 &&
      ctx.minutesToClose < this.noEntryMinutesBeforeClose
    ) {
      return null;
    }

    const direction = fast > slow ? 'LONG' : 'SHORT';

    // Strength scales with separation, saturating at 1% apart. Conviction sizes
    // the position; it never changes the direction.
    const strength = Math.min(1, separation / 0.01);

    return signal({
      symbol: ctx.symbol,
      strategyId: this.id,
      direction,
      strength,
      timestamp: candle.timestamp,
      referencePrice: price,
      stopLoss: atrStopLoss(price, atrValue, direction, this.atrStopMultiplier),
      rationale:
        `EMA${this.fastPeriod} ${direction === 'LONG' ? 'above' : 'below'} ` +
        `EMA${this.slowPeriod} by ${(separation * 100).toFixed(2)}%, ` +
        `ATR ${fromPaise(Math.round(atrValue))}`,
    });
  }
}
