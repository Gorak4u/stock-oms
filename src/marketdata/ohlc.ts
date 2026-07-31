/**
 * Tick → OHLC aggregation.
 *
 * Bars are emitted on the *first tick of the next bucket* rather than on a
 * timer, so replaying a stored tick stream produces byte-identical candles to
 * the live run. A wall-clock timer would make backtests and live trading
 * disagree at exactly the boundaries where strategies act.
 */

import type { Candle, Interval, Tick, Timestamp } from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';

export const INTERVAL_MS: Readonly<Record<Interval, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** Start of the bucket a timestamp belongs to. */
export function bucketStart(timestamp: Timestamp, interval: Interval): Timestamp {
  const size = INTERVAL_MS[interval];
  return Math.floor(timestamp / size) * size;
}

interface OpenBar {
  timestamp: Timestamp;
  open: Paise;
  high: Paise;
  low: Paise;
  close: Paise;
  volume: number;
}

/**
 * Aggregates a tick stream for one symbol into one interval.
 *
 * Ticks must arrive in non-decreasing timestamp order; an out-of-order tick is
 * rejected rather than silently folded into the wrong bar. Feed handlers are
 * expected to sequence or drop before this point.
 */
export class CandleAggregator {
  private bar: OpenBar | null = null;
  private lastTimestamp = -Infinity;

  constructor(
    private readonly symbol: string,
    private readonly interval: Interval,
  ) {}

  /**
   * Folds a tick in. Returns the completed candle when the tick opened a new
   * bucket, otherwise `null`.
   */
  push(tick: Tick): Candle | null {
    if (tick.symbol !== this.symbol) {
      throw new Error(`aggregator for ${this.symbol} received tick for ${tick.symbol}`);
    }
    if (tick.timestamp < this.lastTimestamp) {
      throw new Error(
        `out-of-order tick for ${this.symbol}: ${tick.timestamp} < ${this.lastTimestamp}`,
      );
    }
    this.lastTimestamp = tick.timestamp;

    const start = bucketStart(tick.timestamp, this.interval);

    if (this.bar === null) {
      this.bar = this.openBar(start, tick);
      return null;
    }

    if (start > this.bar.timestamp) {
      const completed = this.toCandle(this.bar);
      this.bar = this.openBar(start, tick);
      return completed;
    }

    this.bar.high = tick.price > this.bar.high ? tick.price : this.bar.high;
    this.bar.low = tick.price < this.bar.low ? tick.price : this.bar.low;
    this.bar.close = tick.price;
    this.bar.volume += tick.quantity;
    return null;
  }

  /**
   * Closes the in-progress bar — call at session close.
   *
   * Without this the final bar of the day is never emitted, because nothing
   * ever arrives to open the next bucket.
   */
  flush(): Candle | null {
    if (this.bar === null) return null;
    const completed = this.toCandle(this.bar);
    this.bar = null;
    return completed;
  }

  private openBar(timestamp: Timestamp, tick: Tick): OpenBar {
    return {
      timestamp,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.quantity,
    };
  }

  private toCandle(bar: OpenBar): Candle {
    return {
      symbol: this.symbol,
      interval: this.interval,
      timestamp: bar.timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    };
  }
}

/**
 * Rolls finer candles up into a coarser interval (1m → 15m, 1d → weekly).
 *
 * The target interval must be a whole multiple of the source, otherwise bars
 * would straddle bucket boundaries and the result would be silently wrong.
 */
export function resample(candles: readonly Candle[], target: Interval): Candle[] {
  if (candles.length === 0) return [];

  const source = candles[0]!.interval;
  if (INTERVAL_MS[target] < INTERVAL_MS[source]) {
    throw new Error(`cannot resample ${source} up to shorter interval ${target}`);
  }
  if (INTERVAL_MS[target] % INTERVAL_MS[source] !== 0) {
    throw new Error(`${target} is not a whole multiple of ${source}`);
  }

  const out: Candle[] = [];
  let current: (OpenBar & { symbol: string }) | null = null;

  for (const candle of candles) {
    const start = bucketStart(candle.timestamp, target);

    if (current === null || start > current.timestamp) {
      if (current) out.push({ ...current, interval: target, volume: current.volume });
      current = {
        symbol: candle.symbol,
        timestamp: start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      continue;
    }

    current.high = candle.high > current.high ? candle.high : current.high;
    current.low = candle.low < current.low ? candle.low : current.low;
    current.close = candle.close;
    current.volume += candle.volume;
  }

  if (current) out.push({ ...current, interval: target, volume: current.volume });
  return out;
}

/** Typical price `(H + L + C) / 3`, the anchor for VWAP and several indicators. */
export function typicalPrice(candle: Candle): Paise {
  return fromPaise(Math.round((candle.high + candle.low + candle.close) / 3));
}
