/**
 * Feature engineering for the model layer.
 *
 * Features are scale-free by construction — ratios, z-scores and normalised
 * distances rather than raw prices. A model trained on rupee prices learns the
 * price level of its training set and stops working when the instrument
 * re-rates or when it is pointed at a different symbol.
 *
 * Every feature at index `i` reads only `candles[0..i]`, matching the same
 * no-lookahead rule the strategy layer follows.
 */

import type { Candle } from '../domain/types';
import {
  atr,
  ema,
  realisedVolatility,
  roc,
  rsi,
  sma,
  zScore,
  type IndicatorSeries,
} from '../features/indicators';
import { closes, highs, lows } from '../strategy/types';
import type { FeatureExtractor, FeatureVector } from './types';

export const STANDARD_FEATURE_NAMES = [
  'rsi14',
  'zScore20',
  'roc5',
  'roc20',
  'emaRatio',
  'atrFraction',
  'volatility20',
  'volumeRatio',
  'rangeFraction',
] as const;

interface Precomputed {
  rsi14: IndicatorSeries;
  z20: IndicatorSeries;
  roc5: IndicatorSeries;
  roc20: IndicatorSeries;
  emaFast: IndicatorSeries;
  emaSlow: IndicatorSeries;
  atr14: IndicatorSeries;
  vol20: IndicatorSeries;
  volumeSma20: IndicatorSeries;
}

/**
 * The platform's default feature set.
 *
 * Caches its indicator arrays against the series it was last given, so
 * extracting bar-by-bar across a backtest stays O(n) overall instead of
 * recomputing every indicator on every bar.
 */
export class StandardFeatureExtractor implements FeatureExtractor {
  readonly featureNames = STANDARD_FEATURE_NAMES;

  private cacheKey: readonly Candle[] | null = null;
  private cache: Precomputed | null = null;

  extract(candles: readonly Candle[], index: number): FeatureVector | null {
    if (index < 0 || index >= candles.length) return null;

    const pre = this.precompute(candles);
    const candle = candles[index]!;

    const rsi14 = pre.rsi14[index];
    const z20 = pre.z20[index];
    const roc5 = pre.roc5[index];
    const roc20 = pre.roc20[index];
    const emaFast = pre.emaFast[index];
    const emaSlow = pre.emaSlow[index];
    const atr14 = pre.atr14[index];
    const vol20 = pre.vol20[index];
    const volumeSma20 = pre.volumeSma20[index];

    // Any undefined feature means the warm-up has not completed. Returning
    // null is the honest answer; zero-filling would feed the model a
    // fabricated observation.
    if (
      rsi14 == null ||
      z20 == null ||
      roc5 == null ||
      roc20 == null ||
      emaFast == null ||
      emaSlow == null ||
      atr14 == null ||
      vol20 == null ||
      volumeSma20 == null ||
      emaSlow === 0 ||
      candle.close === 0
    ) {
      return null;
    }

    return {
      timestamp: candle.timestamp,
      symbol: candle.symbol,
      values: [
        rsi14 / 100,
        z20,
        roc5,
        roc20,
        emaFast / emaSlow - 1,
        atr14 / candle.close,
        vol20,
        volumeSma20 === 0 ? 1 : candle.volume / volumeSma20,
        (candle.high - candle.low) / candle.close,
      ],
    };
  }

  private precompute(candles: readonly Candle[]): Precomputed {
    if (this.cacheKey === candles && this.cache) return this.cache;

    const close = closes(candles);
    const ohlc = { high: highs(candles), low: lows(candles), close };
    const volume = candles.map((candle) => candle.volume);

    this.cache = {
      rsi14: rsi(close, 14),
      z20: zScore(close, 20),
      roc5: roc(close, 5),
      roc20: roc(close, 20),
      emaFast: ema(close, 12),
      emaSlow: ema(close, 26),
      atr14: atr(ohlc, 14),
      vol20: realisedVolatility(close, 20),
      volumeSma20: sma(volume, 20),
    };
    this.cacheKey = candles;

    return this.cache;
  }
}

/**
 * Fits per-feature mean and standard deviation for standardisation.
 *
 * Must be fitted on the *training* window only, then applied unchanged to
 * validation and live data. Refitting on the full set leaks the future into
 * the training distribution — a subtle form of lookahead that inflates every
 * validation metric.
 */
export class FeatureScaler {
  private means: number[] = [];
  private deviations: number[] = [];

  fit(vectors: readonly FeatureVector[]): void {
    if (vectors.length === 0) throw new Error('cannot fit a scaler on an empty sample');

    const width = vectors[0]!.values.length;
    this.means = new Array<number>(width).fill(0);
    this.deviations = new Array<number>(width).fill(0);

    for (const vector of vectors) {
      for (let i = 0; i < width; i += 1) this.means[i]! += vector.values[i]!;
    }
    for (let i = 0; i < width; i += 1) this.means[i]! /= vectors.length;

    for (const vector of vectors) {
      for (let i = 0; i < width; i += 1) {
        const delta = vector.values[i]! - this.means[i]!;
        this.deviations[i]! += delta * delta;
      }
    }
    for (let i = 0; i < width; i += 1) {
      this.deviations[i] = Math.sqrt(this.deviations[i]! / vectors.length) || 1;
    }
  }

  transform(vector: FeatureVector): FeatureVector {
    if (this.means.length === 0) throw new Error('scaler used before fit');
    return {
      ...vector,
      values: vector.values.map((value, i) => (value - this.means[i]!) / this.deviations[i]!),
    };
  }
}
