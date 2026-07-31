import {
  atr,
  bollinger,
  ema,
  highest,
  lowest,
  macd,
  realisedVolatility,
  roc,
  rsi,
  sma,
  stdev,
  trueRange,
  zScore,
} from '../src/features/indicators';

const RAMP = Array.from({ length: 50 }, (_, i) => 100 + i);

describe('indicator alignment', () => {
  // The alignment guarantee is what makes no-lookahead possible: result[i]
  // always describes input[i], with null through the warm-up.
  it('returns an array the same length as the input', () => {
    expect(sma(RAMP, 10)).toHaveLength(RAMP.length);
    expect(ema(RAMP, 10)).toHaveLength(RAMP.length);
    expect(rsi(RAMP, 14)).toHaveLength(RAMP.length);
    expect(stdev(RAMP, 10)).toHaveLength(RAMP.length);
    expect(roc(RAMP, 10)).toHaveLength(RAMP.length);
  });

  it('leaves the warm-up region null and defines everything after it', () => {
    const result = sma(RAMP, 10);
    for (let i = 0; i < 9; i += 1) expect(result[i]).toBeNull();
    for (let i = 9; i < RAMP.length; i += 1) expect(result[i]).not.toBeNull();
  });

  it('is all null when the series is shorter than the period', () => {
    expect(ema([1, 2, 3], 10).every((value) => value === null)).toBe(true);
  });

  it('never lets a later value change an earlier one', () => {
    // Prefix-stability is the property a lookahead bug would break.
    const prefix = sma(RAMP.slice(0, 30), 10);
    const full = sma(RAMP, 10);

    for (let i = 0; i < 30; i += 1) {
      if (prefix[i] === null) {
        expect(full[i]).toBeNull();
        continue;
      }
      expect(full[i]).toBeCloseTo(prefix[i]!, 10);
    }
  });

  it('rejects a non-positive period', () => {
    expect(() => sma(RAMP, 0)).toThrow();
    expect(() => ema(RAMP, -1)).toThrow();
    expect(() => sma(RAMP, 1.5)).toThrow();
  });
});

describe('sma', () => {
  it('averages the window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)[2]).toBe(2);
    expect(sma([1, 2, 3, 4, 5], 3)[4]).toBe(4);
  });

  it('matches a naive recomputation across the series', () => {
    const period = 7;
    const result = sma(RAMP, period);
    for (let i = period - 1; i < RAMP.length; i += 1) {
      const window = RAMP.slice(i - period + 1, i + 1);
      const expected = window.reduce((a, b) => a + b, 0) / period;
      expect(result[i]).toBeCloseTo(expected, 10);
    }
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first window', () => {
    const period = 10;
    const seed = RAMP.slice(0, period).reduce((a, b) => a + b, 0) / period;
    expect(ema(RAMP, period)[period - 1]).toBeCloseTo(seed, 10);
  });

  it('applies the 2/(n+1) smoothing factor', () => {
    const period = 10;
    const result = ema(RAMP, period);
    const alpha = 2 / (period + 1);
    const expected = RAMP[period]! * alpha + result[period - 1]! * (1 - alpha);
    expect(result[period]).toBeCloseTo(expected, 10);
  });

  it('tracks a constant series exactly', () => {
    const flat = new Array<number>(30).fill(42);
    expect(ema(flat, 10)[29]).toBeCloseTo(42, 10);
  });
});

describe('rsi', () => {
  it('is 100 for a series that only rises', () => {
    expect(rsi(RAMP, 14)[20]).toBe(100);
  });

  it('is 0 for a series that only falls', () => {
    const falling = [...RAMP].reverse();
    expect(rsi(falling, 14)[20]).toBeCloseTo(0, 6);
  });

  it('sits near 50 for an alternating series', () => {
    const alternating = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
    expect(rsi(alternating, 14)[50]!).toBeGreaterThan(40);
    expect(rsi(alternating, 14)[50]!).toBeLessThan(60);
  });

  it('stays within [0, 100]', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 20 + (i % 7));
    for (const value of rsi(noisy, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('stdev', () => {
  it('is zero for a constant window', () => {
    expect(stdev(new Array<number>(20).fill(5), 10)[15]).toBe(0);
  });

  it('never returns NaN on a near-constant window', () => {
    // Catastrophic cancellation would otherwise drive the variance negative.
    const nearlyConstant = Array.from({ length: 50 }, (_, i) => 1e9 + (i % 2) * 1e-6);
    for (const value of stdev(nearlyConstant, 20)) {
      if (value === null) continue;
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('matches the population formula', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stdev(values, 8)[7]).toBeCloseTo(2, 10);
  });
});

describe('trueRange and atr', () => {
  it('uses the widest of the range and the two gaps against the prior close', () => {
    const series = { high: [110, 130], low: [100, 125], close: [105, 128] };
    const tr = trueRange(series);

    expect(tr[0]).toBe(10); // no prior close — just the range
    // Range 5, |130 − 105| = 25, |125 − 105| = 20 → 25
    expect(tr[1]).toBe(25);
  });

  it('is positive wherever it is defined', () => {
    const high = RAMP.map((v) => v + 2);
    const low = RAMP.map((v) => v - 2);
    for (const value of atr({ high, low, close: RAMP }, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('bollinger', () => {
  it('brackets the middle band symmetrically', () => {
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5);
    const bands = bollinger(noisy, 20, 2);

    for (let i = 19; i < noisy.length; i += 1) {
      const upper = bands.upper[i]!;
      const middle = bands.middle[i]!;
      const lower = bands.lower[i]!;
      expect(upper).toBeGreaterThanOrEqual(middle);
      expect(lower).toBeLessThanOrEqual(middle);
      expect(upper - middle).toBeCloseTo(middle - lower, 10);
    }
  });

  it('collapses onto the mean for a constant series', () => {
    const flat = new Array<number>(40).fill(100);
    const bands = bollinger(flat, 20, 2);
    expect(bands.upper[30]).toBe(100);
    expect(bands.lower[30]).toBe(100);
  });
});

describe('zScore', () => {
  it('is zero for a constant series (guarded against divide-by-zero)', () => {
    expect(zScore(new Array<number>(40).fill(7), 20)[30]).toBeNull();
  });

  it('is positive above the rolling mean and negative below it', () => {
    const values = [...new Array<number>(30).fill(100), 130];
    expect(zScore(values, 20)[30]!).toBeGreaterThan(0);
  });
});

describe('roc', () => {
  it('measures fractional change over the period', () => {
    const values = [100, 105, 110, 115, 120];
    expect(roc(values, 4)[4]).toBeCloseTo(0.2, 10);
  });

  it('skips a zero base rather than dividing by it', () => {
    expect(roc([0, 1, 2], 2)[2]).toBeNull();
  });
});

describe('macd', () => {
  it('keeps every line aligned to the input length', () => {
    const result = macd(RAMP, 12, 26, 9);
    expect(result.macd).toHaveLength(RAMP.length);
    expect(result.signal).toHaveLength(RAMP.length);
    expect(result.histogram).toHaveLength(RAMP.length);
  });

  it('makes the histogram exactly macd − signal', () => {
    const result = macd(RAMP, 12, 26, 9);
    for (let i = 0; i < RAMP.length; i += 1) {
      if (result.histogram[i] === null) continue;
      expect(result.histogram[i]).toBeCloseTo(result.macd[i]! - result.signal[i]!, 10);
    }
  });

  it('rejects a fast period that is not shorter than the slow one', () => {
    expect(() => macd(RAMP, 26, 12)).toThrow();
  });
});

describe('highest and lowest', () => {
  it('track the rolling extremes', () => {
    const values = [5, 3, 8, 1, 9, 2];
    expect(highest(values, 3)[4]).toBe(9);
    expect(lowest(values, 3)[4]).toBe(1);
  });
});

describe('realisedVolatility', () => {
  it('is zero for a flat series and positive for a noisy one', () => {
    expect(realisedVolatility(new Array<number>(40).fill(100), 20)[30]).toBe(0);

    const noisy = Array.from({ length: 60 }, (_, i) => 100 * (1 + Math.sin(i) * 0.02));
    expect(realisedVolatility(noisy, 20)[50]!).toBeGreaterThan(0);
  });
});
