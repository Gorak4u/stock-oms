/**
 * Volatility breakout — trade the expansion that follows a squeeze.
 *
 * Volatility is mean-reverting even where price is not: unusually quiet periods
 * tend to be followed by expansion. The strategy waits for band width to fall
 * into the bottom of its own recent range (the "squeeze"), then takes the
 * direction of the break out of it.
 *
 * Direction is taken from the break, not predicted during the squeeze — a
 * squeeze says a move is coming, never which way.
 */

import type { Candle } from '../domain/types';
import { atr, bollinger, type IndicatorSeries } from '../features/indicators';
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

export interface VolatilityBreakoutConfig {
  readonly bandPeriod?: number;
  readonly bandMultiplier?: number;
  /** Window over which band width is ranked to identify a squeeze. */
  readonly squeezeLookback?: number;
  /** Band width percentile below which the market counts as squeezed. */
  readonly squeezePercentile?: number;
  readonly atrPeriod?: number;
  readonly atrStopMultiplier?: number;
  readonly allowShorts?: boolean;
}

interface Prepared {
  readonly upper: IndicatorSeries;
  readonly lower: IndicatorSeries;
  readonly middle: IndicatorSeries;
  /** Band width as a fraction of the mid — comparable across price levels. */
  readonly width: IndicatorSeries;
  readonly squeezed: boolean[];
  readonly atrValues: IndicatorSeries;
}

export class VolatilityBreakoutStrategy implements Strategy<Prepared> {
  readonly id: string;
  readonly warmupBars: number;

  private readonly bandPeriod: number;
  private readonly bandMultiplier: number;
  private readonly squeezeLookback: number;
  private readonly squeezePercentile: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly allowShorts: boolean;

  constructor(config: VolatilityBreakoutConfig = {}, id = 'volatility-breakout') {
    this.bandPeriod = config.bandPeriod ?? 20;
    this.bandMultiplier = config.bandMultiplier ?? 2;
    this.squeezeLookback = config.squeezeLookback ?? 100;
    this.squeezePercentile = config.squeezePercentile ?? 0.25;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.atrStopMultiplier = config.atrStopMultiplier ?? 2;
    this.allowShorts = config.allowShorts ?? false;

    this.id = id;
    this.warmupBars = Math.max(this.bandPeriod + this.squeezeLookback, this.atrPeriod) + 2;
  }

  prepare(candles: readonly Candle[]): Prepared {
    const close = closes(candles);
    const bands = bollinger(close, this.bandPeriod, this.bandMultiplier);

    const width: IndicatorSeries = close.map((_, i) => {
      const upper = bands.upper[i];
      const lower = bands.lower[i];
      const middle = bands.middle[i];
      if (upper == null || lower == null || middle == null || middle === 0) return null;
      return (upper - lower) / middle;
    });

    // A bar is squeezed when its band width sits in the bottom percentile of
    // the trailing window — a relative measure, so it adapts per instrument
    // instead of relying on a hard-coded width.
    const squeezed = width.map((value, i) => {
      if (value == null || i < this.squeezeLookback) return false;

      const window: number[] = [];
      for (let j = i - this.squeezeLookback + 1; j <= i; j += 1) {
        const candidate = width[j];
        if (candidate != null) window.push(candidate);
      }
      if (window.length < this.squeezeLookback / 2) return false;

      window.sort((a, b) => a - b);
      const cutoffIndex = Math.floor(window.length * this.squeezePercentile);
      const cutoff = window[Math.min(cutoffIndex, window.length - 1)]!;
      return value <= cutoff;
    });

    return {
      upper: bands.upper,
      lower: bands.lower,
      middle: bands.middle,
      width,
      squeezed,
      atrValues: atr({ high: highs(candles), low: lows(candles), close }, this.atrPeriod),
    };
  }

  evaluate(ctx: StrategyContext, prepared: Prepared) {
    const { index } = ctx;
    if (index < this.warmupBars) return null;

    const upper = prepared.upper[index];
    const lower = prepared.lower[index];
    const middle = prepared.middle[index];
    const atrValue = prepared.atrValues[index];
    if (upper == null || lower == null || middle == null || atrValue == null || atrValue <= 0) {
      return null;
    }

    const candle = ctx.candles[index]!;
    const price = candle.close;
    const held = positionDirection(ctx.position);

    // Exit when price returns to the mean — the expansion has played out.
    if (held === 'LONG' && price < middle) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: 'closed back below the band mid — expansion over',
      });
    }
    if (held === 'SHORT' && price > middle) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: 'closed back above the band mid — expansion over',
      });
    }

    if (held !== 'FLAT') return null;

    // The squeeze is read on the previous bar; the break happens on this one.
    if (!prepared.squeezed[index - 1]) return null;

    const brokeUp = price > upper;
    const brokeDown = this.allowShorts && price < lower;
    if (!brokeUp && !brokeDown) return null;

    const direction = brokeUp ? 'LONG' : 'SHORT';
    const currentWidth = prepared.width[index] ?? 0;
    const strength = Math.min(1, 0.5 + currentWidth * 10);

    return signal({
      symbol: ctx.symbol,
      strategyId: this.id,
      direction,
      strength,
      timestamp: candle.timestamp,
      referencePrice: price,
      stopLoss: atrStopLoss(price, atrValue, direction, this.atrStopMultiplier),
      rationale:
        `broke ${brokeUp ? 'above' : 'below'} the Bollinger band out of a ` +
        `bottom-${(this.squeezePercentile * 100).toFixed(0)}% width squeeze`,
    });
  }
}
