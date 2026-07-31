/**
 * Mean reversion — fade statistically extreme moves back to a rolling mean.
 *
 * Mean reversion is the mirror image of trend following and fails in exactly
 * the situation trend following thrives in: a strong directional move looks
 * like an ever-more-attractive fade right up until it ruins the account. Two
 * guards address that:
 *
 * - **A trend filter.** No fading while a longer-term trend is intact — a
 *   stretched price in a strong trend is a trend, not an anomaly.
 * - **A hard stop beyond the entry z-score.** The position is abandoned when
 *   the move extends rather than reverting, which is the "it has to come back
 *   eventually" trade the strategy must not take.
 */

import type { Candle } from '../domain/types';
import { atr, ema, zScore, type IndicatorSeries } from '../features/indicators';
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

export interface MeanReversionConfig {
  readonly lookback?: number;
  /** Z-score magnitude that triggers an entry. */
  readonly entryZ?: number;
  /** Z-score magnitude at which the position is closed as reverted. */
  readonly exitZ?: number;
  /** Trend filter period; entries are refused against this trend. */
  readonly trendPeriod?: number;
  readonly atrPeriod?: number;
  readonly atrStopMultiplier?: number;
}

interface Prepared {
  readonly z: IndicatorSeries;
  readonly trend: IndicatorSeries;
  readonly atrValues: IndicatorSeries;
}

export class MeanReversionStrategy implements Strategy<Prepared> {
  readonly id: string;
  readonly warmupBars: number;

  private readonly lookback: number;
  private readonly entryZ: number;
  private readonly exitZ: number;
  private readonly trendPeriod: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;

  constructor(config: MeanReversionConfig = {}, id = 'mean-reversion') {
    this.lookback = config.lookback ?? 20;
    this.entryZ = config.entryZ ?? 2;
    this.exitZ = config.exitZ ?? 0.5;
    this.trendPeriod = config.trendPeriod ?? 100;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.atrStopMultiplier = config.atrStopMultiplier ?? 3;

    if (this.exitZ >= this.entryZ) {
      throw new Error('mean-reversion exit z must be tighter than entry z');
    }

    this.id = id;
    this.warmupBars = Math.max(this.lookback, this.trendPeriod, this.atrPeriod) + 1;
  }

  prepare(candles: readonly Candle[]): Prepared {
    const close = closes(candles);
    return {
      z: zScore(close, this.lookback),
      trend: ema(close, this.trendPeriod),
      atrValues: atr({ high: highs(candles), low: lows(candles), close }, this.atrPeriod),
    };
  }

  evaluate(ctx: StrategyContext, prepared: Prepared) {
    const { index } = ctx;
    if (index < this.warmupBars) return null;

    const z = prepared.z[index];
    const trend = prepared.trend[index];
    const atrValue = prepared.atrValues[index];
    if (z == null || trend == null || atrValue == null || atrValue <= 0) return null;

    const candle = ctx.candles[index]!;
    const price = candle.close;
    const held = positionDirection(ctx.position);

    if (held !== 'FLAT') {
      const reverted = Math.abs(z) <= this.exitZ;
      const extended =
        (held === 'LONG' && z <= -this.entryZ * 1.5) ||
        (held === 'SHORT' && z >= this.entryZ * 1.5);

      if (reverted || extended) {
        return signal({
          symbol: ctx.symbol,
          strategyId: this.id,
          direction: 'FLAT',
          strength: 1,
          timestamp: candle.timestamp,
          referencePrice: price,
          rationale: reverted
            ? `z-score ${z.toFixed(2)} back inside ±${this.exitZ} — reverted`
            : `z-score ${z.toFixed(2)} extended against the position — abandoning`,
        });
      }
      return null;
    }

    if (Math.abs(z) < this.entryZ) return null;

    const direction = z < 0 ? 'LONG' : 'SHORT';

    // Do not fade a live trend: only buy dips above the trend line, only sell
    // rallies below it.
    const withTrend = direction === 'LONG' ? price > trend : price < trend;
    if (!withTrend) return null;

    const strength = Math.min(1, (Math.abs(z) - this.entryZ) / this.entryZ + 0.5);

    return signal({
      symbol: ctx.symbol,
      strategyId: this.id,
      direction,
      strength,
      timestamp: candle.timestamp,
      referencePrice: price,
      stopLoss: atrStopLoss(price, atrValue, direction, this.atrStopMultiplier),
      rationale:
        `z-score ${z.toFixed(2)} beyond ±${this.entryZ} over ${this.lookback} bars, ` +
        `${direction === 'LONG' ? 'above' : 'below'} the EMA${this.trendPeriod} trend`,
    });
  }
}
