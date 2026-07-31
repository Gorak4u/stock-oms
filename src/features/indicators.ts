/**
 * Technical indicators.
 *
 * Every function returns an array the same length as its input, with `null`
 * for the warm-up region where the indicator is not yet defined. Returning a
 * shortened array instead is the classic source of off-by-one lookahead bias:
 * index `i` of the result always corresponds to index `i` of the input, so a
 * strategy reading `rsi[i]` can never accidentally read a future value.
 *
 * Inputs are plain numbers (paise). These are ratios and averages, not money,
 * so they are not branded — an EMA of a price is not itself a payable amount.
 */

export type Series = readonly number[];
export type IndicatorSeries = (number | null)[];

function filled(length: number): IndicatorSeries {
  return new Array<number | null>(length).fill(null);
}

function assertPeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${name} period must be a positive integer, got ${period}`);
  }
}

/** Simple moving average. Rolling sum — O(n) regardless of period. */
export function sma(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'sma');
  const out = filled(values.length);
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }

  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * Seeding matters: starting the recursion from `values[0]` leaves a transient
 * that takes several periods to decay, and makes the indicator depend on how
 * much history happened to be loaded.
 */
export function ema(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'ema');
  const out = filled(values.length);
  if (values.length < period) return out;

  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;

  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = values[i]! * alpha + previous * (1 - alpha);
    out[i] = previous;
  }

  return out;
}

/** Wilder's smoothing (`alpha = 1/period`) — the basis of RSI, ATR and ADX. */
export function wilderSmooth(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'wilderSmooth');
  const out = filled(values.length);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;

  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = (previous * (period - 1) + values[i]!) / period;
    out[i] = previous;
  }

  return out;
}

/** Population standard deviation over a rolling window. */
export function stdev(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'stdev');
  const out = filled(values.length);
  if (period === 1) return values.map(() => 0);

  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    sum += value;
    sumSquares += value * value;

    if (i >= period) {
      const dropped = values[i - period]!;
      sum -= dropped;
      sumSquares -= dropped * dropped;
    }

    if (i >= period - 1) {
      const mean = sum / period;
      // Clamped at zero: catastrophic cancellation on near-constant windows
      // can drive this a hair below zero and produce NaN from the sqrt.
      const variance = Math.max(0, sumSquares / period - mean * mean);
      out[i] = Math.sqrt(variance);
    }
  }

  return out;
}

/**
 * Relative Strength Index (Wilder).
 *
 * Returns 100 when the window contains no losses — the textbook `100 - 100/(1+RS)`
 * divides by zero there.
 */
export function rsi(values: Series, period = 14): IndicatorSeries {
  assertPeriod(period, 'rsi');
  const out = filled(values.length);
  if (values.length <= period) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];

  for (let i = 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    avgGain += gains[i]!;
    avgLoss += losses[i]!;
  }
  avgGain /= period;
  avgLoss /= period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

export interface OhlcSeries {
  readonly high: Series;
  readonly low: Series;
  readonly close: Series;
}

/** True Range: the widest of today's range and the two gaps against yesterday's close. */
export function trueRange(series: OhlcSeries): number[] {
  const { high, low, close } = series;
  const out: number[] = [];

  for (let i = 0; i < close.length; i += 1) {
    if (i === 0) {
      out.push(high[i]! - low[i]!);
      continue;
    }
    const previousClose = close[i - 1]!;
    out.push(
      Math.max(
        high[i]! - low[i]!,
        Math.abs(high[i]! - previousClose),
        Math.abs(low[i]! - previousClose),
      ),
    );
  }

  return out;
}

/**
 * Average True Range — the platform's volatility unit.
 *
 * Position sizing and stop distance are both quoted in ATR so that risk per
 * trade stays constant across instruments with very different price levels.
 */
export function atr(series: OhlcSeries, period = 14): IndicatorSeries {
  return wilderSmooth(trueRange(series), period);
}

export interface BollingerBands {
  readonly upper: IndicatorSeries;
  readonly middle: IndicatorSeries;
  readonly lower: IndicatorSeries;
}

export function bollinger(values: Series, period = 20, multiplier = 2): BollingerBands {
  const middle = sma(values, period);
  const deviation = stdev(values, period);

  const upper = filled(values.length);
  const lower = filled(values.length);

  for (let i = 0; i < values.length; i += 1) {
    const mid = middle[i];
    const dev = deviation[i];
    if (mid === null || mid === undefined || dev === null || dev === undefined) continue;
    upper[i] = mid + multiplier * dev;
    lower[i] = mid - multiplier * dev;
  }

  return { upper, middle, lower };
}

/**
 * Z-score of the latest value against its rolling window — how many standard
 * deviations from the mean. The mean-reversion strategy trades on this.
 */
export function zScore(values: Series, period = 20): IndicatorSeries {
  const mean = sma(values, period);
  const deviation = stdev(values, period);
  const out = filled(values.length);

  for (let i = 0; i < values.length; i += 1) {
    const m = mean[i];
    const d = deviation[i];
    if (m === null || m === undefined || d === null || d === undefined || d === 0) continue;
    out[i] = (values[i]! - m) / d;
  }

  return out;
}

/** Rate of change over `period` bars, as a fraction. */
export function roc(values: Series, period = 10): IndicatorSeries {
  assertPeriod(period, 'roc');
  const out = filled(values.length);

  for (let i = period; i < values.length; i += 1) {
    const past = values[i - period]!;
    if (past === 0) continue;
    out[i] = values[i]! / past - 1;
  }

  return out;
}

export interface MacdResult {
  readonly macd: IndicatorSeries;
  readonly signal: IndicatorSeries;
  readonly histogram: IndicatorSeries;
}

export function macd(
  values: Series,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (fastPeriod >= slowPeriod) {
    throw new Error('macd fast period must be shorter than slow period');
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine = filled(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    macdLine[i] = f - s;
  }

  // The signal EMA is defined only over the region where MACD exists, then
  // written back at the matching offset so alignment is preserved.
  const firstDefined = macdLine.findIndex((value) => value !== null);
  const signal = filled(values.length);
  const histogram = filled(values.length);

  if (firstDefined >= 0) {
    const dense = macdLine.slice(firstDefined) as number[];
    const signalDense = ema(dense, signalPeriod);

    for (let i = 0; i < signalDense.length; i += 1) {
      const value = signalDense[i];
      if (value === null || value === undefined) continue;
      const index = firstDefined + i;
      signal[index] = value;
      histogram[index] = macdLine[index]! - value;
    }
  }

  return { macd: macdLine, signal, histogram };
}

/** Rolling maximum over `period` bars (Donchian upper channel). */
export function highest(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'highest');
  const out = filled(values.length);

  for (let i = period - 1; i < values.length; i += 1) {
    let best = -Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (values[j]! > best) best = values[j]!;
    }
    out[i] = best;
  }

  return out;
}

/** Rolling minimum over `period` bars (Donchian lower channel). */
export function lowest(values: Series, period: number): IndicatorSeries {
  assertPeriod(period, 'lowest');
  const out = filled(values.length);

  for (let i = period - 1; i < values.length; i += 1) {
    let best = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (values[j]! < best) best = values[j]!;
    }
    out[i] = best;
  }

  return out;
}

/** Annualised realised volatility from log returns. 252 NSE sessions per year. */
export function realisedVolatility(values: Series, period = 20, periodsPerYear = 252): IndicatorSeries {
  const logReturns: number[] = [0];
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1]!;
    logReturns.push(previous > 0 ? Math.log(values[i]! / previous) : 0);
  }

  const deviation = stdev(logReturns, period);
  return deviation.map((value) => (value === null ? null : value * Math.sqrt(periodsPerYear)));
}
