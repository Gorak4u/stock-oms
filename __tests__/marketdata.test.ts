import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Tick } from '../src/domain/types';
import {
  fromIst,
  MarketCalendar,
  NSE_HOLIDAYS_2026,
  toIstDate,
  toIstMinuteOfDay,
} from '../src/marketdata/calendar';
import { bucketStart, CandleAggregator, resample } from '../src/marketdata/ohlc';
import { TickValidator, validateCandle } from '../src/marketdata/validation';
import {
  adjustForCorporateActions,
  adjustmentFactor,
  findUnexplainedGaps,
} from '../src/marketdata/corporateActions';

const calendar = new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 });

describe('MarketCalendar', () => {
  it('converts epoch to the IST civil date, including across the UTC day boundary', () => {
    // 2026-03-02T19:00:00Z is 2026-03-03 00:30 IST — the next day.
    expect(toIstDate(Date.parse('2026-03-02T19:00:00Z'))).toBe('2026-03-03');
    expect(toIstDate(Date.parse('2026-03-02T09:00:00Z'))).toBe('2026-03-02');
  });

  it('reports IST minutes past midnight', () => {
    expect(toIstMinuteOfDay(Date.parse('2026-03-02T03:45:00Z'))).toBe(9 * 60 + 15);
  });

  it('treats weekends as non-trading days', () => {
    expect(calendar.isTradingDay('2026-03-07')).toBe(false); // Saturday
    expect(calendar.isTradingDay('2026-03-08')).toBe(false); // Sunday
    expect(calendar.isTradingDay('2026-03-06')).toBe(true); // Friday
  });

  it('treats listed holidays as non-trading days', () => {
    expect(calendar.isTradingDay('2026-01-26')).toBe(false);
    expect(calendar.isHoliday('2026-01-26')).toBe(true);
  });

  it('opens at 09:15 and closes at 15:30 IST', () => {
    const session = calendar.sessionFor('2026-03-02')!;
    expect(session.open).toBe(fromIst('2026-03-02', 9 * 60 + 15));
    expect(session.close).toBe(fromIst('2026-03-02', 15 * 60 + 30));
  });

  it('knows when the market is open, treating the close as exclusive', () => {
    expect(calendar.isMarketOpen(fromIst('2026-03-02', 9 * 60 + 14))).toBe(false);
    expect(calendar.isMarketOpen(fromIst('2026-03-02', 9 * 60 + 15))).toBe(true);
    expect(calendar.isMarketOpen(fromIst('2026-03-02', 15 * 60 + 29))).toBe(true);
    expect(calendar.isMarketOpen(fromIst('2026-03-02', 15 * 60 + 30))).toBe(false);
  });

  it('is shut all day on a holiday', () => {
    expect(calendar.isMarketOpen(fromIst('2026-01-26', 12 * 60))).toBe(false);
  });

  it('skips weekends and holidays when walking forward', () => {
    expect(calendar.nextTradingDay('2026-03-06')).toBe('2026-03-09'); // Fri → Mon
    expect(calendar.previousTradingDay('2026-03-09')).toBe('2026-03-06');
  });

  it('enumerates trading days in a range', () => {
    const days = calendar.tradingDaysBetween('2026-03-02', '2026-03-08');
    expect(days).toEqual([
      '2026-03-02',
      '2026-03-03',
      // 2026-03-04 is Holi
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  it('counts down the minutes to the close', () => {
    expect(calendar.minutesToClose(fromIst('2026-03-02', 15 * 60))).toBe(30);
    expect(calendar.minutesToClose(fromIst('2026-03-02', 16 * 60))).toBe(0);
  });

  it('honours a special shortened session', () => {
    const muhurat = new MarketCalendar({
      holidays: ['2026-11-08'],
      specialSessions: { '2026-11-08': { openMinute: 18 * 60, closeMinute: 19 * 60 } },
    });

    expect(muhurat.isTradingDay('2026-11-08')).toBe(true);
    expect(muhurat.isMarketOpen(fromIst('2026-11-08', 18 * 60 + 30))).toBe(true);
    expect(muhurat.isMarketOpen(fromIst('2026-11-08', 12 * 60))).toBe(false);
  });

  it('rejects a session that closes before it opens', () => {
    expect(
      () => new MarketCalendar({ holidays: [], sessionOpenMinute: 900, sessionCloseMinute: 500 }),
    ).toThrow();
  });
});

describe('CandleAggregator', () => {
  function tick(minute: number, price: number, quantity = 10): Tick {
    return {
      symbol: 'NSE:RELIANCE',
      timestamp: fromIst('2026-03-02', 9 * 60 + 15 + minute),
      price: fromRupees(price),
      quantity,
    };
  }

  it('emits a bar only when the next bucket opens', () => {
    const aggregator = new CandleAggregator('NSE:RELIANCE', '1m');

    expect(aggregator.push(tick(0, 100))).toBeNull();
    expect(aggregator.push(tick(0, 102))).toBeNull();
    const emitted = aggregator.push(tick(1, 103));

    expect(emitted).not.toBeNull();
    expect(emitted!.open).toBe(fromRupees(100));
    expect(emitted!.close).toBe(fromRupees(102));
  });

  it('tracks the high, low and cumulative volume', () => {
    const aggregator = new CandleAggregator('NSE:RELIANCE', '1m');
    aggregator.push(tick(0, 100, 5));
    aggregator.push(tick(0, 110, 7));
    aggregator.push(tick(0, 95, 3));
    aggregator.push(tick(0, 105, 1));

    const bar = aggregator.flush()!;
    expect(bar.open).toBe(fromRupees(100));
    expect(bar.high).toBe(fromRupees(110));
    expect(bar.low).toBe(fromRupees(95));
    expect(bar.close).toBe(fromRupees(105));
    expect(bar.volume).toBe(16);
  });

  it('emits the final bar on flush — nothing else ever would', () => {
    const aggregator = new CandleAggregator('NSE:RELIANCE', '1m');
    aggregator.push(tick(0, 100));

    expect(aggregator.flush()).not.toBeNull();
    expect(aggregator.flush()).toBeNull();
  });

  it('rejects an out-of-order tick rather than folding it into the wrong bar', () => {
    const aggregator = new CandleAggregator('NSE:RELIANCE', '1m');
    aggregator.push(tick(5, 100));
    expect(() => aggregator.push(tick(4, 101))).toThrow(/out-of-order/);
  });

  it('rejects a tick for a different symbol', () => {
    const aggregator = new CandleAggregator('NSE:RELIANCE', '1m');
    expect(() => aggregator.push({ ...tick(0, 100), symbol: 'NSE:TCS' })).toThrow();
  });

  it('buckets timestamps to the interval', () => {
    expect(bucketStart(60_000 + 30_000, '1m')).toBe(60_000);
    expect(bucketStart(900_000 + 1, '15m')).toBe(900_000);
  });
});

describe('resample', () => {
  function candle(minute: number, o: number, h: number, l: number, c: number, v: number): Candle {
    return {
      symbol: 'NSE:RELIANCE',
      interval: '1m',
      timestamp: minute * 60_000,
      open: fromRupees(o),
      high: fromRupees(h),
      low: fromRupees(l),
      close: fromRupees(c),
      volume: v,
    };
  }

  it('rolls finer bars up, keeping first open and last close', () => {
    const minutes = [
      candle(0, 100, 105, 99, 104, 10),
      candle(1, 104, 108, 103, 107, 20),
      candle(2, 107, 110, 101, 102, 30),
      candle(3, 102, 103, 100, 101, 40),
      candle(4, 101, 106, 100, 105, 50),
    ];

    const [bar] = resample(minutes, '5m');
    expect(bar!.open).toBe(fromRupees(100));
    expect(bar!.high).toBe(fromRupees(110));
    expect(bar!.low).toBe(fromRupees(99));
    expect(bar!.close).toBe(fromRupees(105));
    expect(bar!.volume).toBe(150);
  });

  it('refuses to resample to a shorter or non-multiple interval', () => {
    const minutes = [candle(0, 100, 100, 100, 100, 1)];
    expect(() => resample(minutes, '1m' as never)).not.toThrow();
    expect(() => resample(resample(minutes, '5m'), '1m')).toThrow();
  });

  it('returns an empty array for empty input', () => {
    expect(resample([], '5m')).toEqual([]);
  });
});

describe('TickValidator', () => {
  const now = 1_700_000_000_000;

  function tick(overrides: Partial<Tick> = {}): Tick {
    return {
      symbol: 'NSE:RELIANCE',
      timestamp: now,
      price: fromRupees(2500),
      quantity: 10,
      ...overrides,
    };
  }

  it('accepts a well-formed tick', () => {
    expect(new TickValidator().validate(tick(), now).valid).toBe(true);
  });

  it('rejects a zero or negative price', () => {
    const result = new TickValidator().validate(tick({ price: 0 as Paise }), now);
    expect(result.rejections.map((r) => r.code)).toContain('NON_POSITIVE_PRICE');
  });

  it('rejects a crossed quote', () => {
    const result = new TickValidator().validate(
      tick({ bid: fromRupees(2510), ask: fromRupees(2500) }),
      now,
    );
    expect(result.rejections.map((r) => r.code)).toContain('CROSSED_QUOTE');
  });

  it('rejects a timestamp beyond the clock-skew tolerance', () => {
    const result = new TickValidator().validate(tick({ timestamp: now + 60_000 }), now);
    expect(result.rejections.map((r) => r.code)).toContain('FUTURE_TIMESTAMP');
  });

  it('rejects a stale tick', () => {
    const result = new TickValidator().validate(tick({ timestamp: now - 120_000 }), now);
    expect(result.rejections.map((r) => r.code)).toContain('STALE_TIMESTAMP');
  });

  it('rejects a fat-finger spike against the last accepted price', () => {
    const validator = new TickValidator({ maxMoveFraction: 0.1 });
    expect(validator.validate(tick(), now).valid).toBe(true);

    const spike = validator.validate(tick({ price: fromRupees(5000) }), now);
    expect(spike.rejections.map((r) => r.code)).toContain('PRICE_SPIKE');
  });

  it('does not advance the reference price on a rejected tick', () => {
    const validator = new TickValidator({ maxMoveFraction: 0.1 });
    validator.validate(tick(), now);
    validator.validate(tick({ price: fromRupees(5000) }), now);

    expect(validator.referencePrice).toBe(fromRupees(2500));
  });

  it('reports staleness when no fresh tick has arrived', () => {
    const validator = new TickValidator({ maxAgeMs: 60_000 });
    expect(validator.isStale(now)).toBe(true);

    validator.validate(tick(), now);
    expect(validator.isStale(now)).toBe(false);
    expect(validator.isStale(now + 120_000)).toBe(true);
  });
});

describe('validateCandle', () => {
  function candle(o: number, h: number, l: number, c: number, volume = 100): Candle {
    return {
      symbol: 'NSE:RELIANCE',
      interval: '1d',
      timestamp: 0,
      open: fromRupees(o),
      high: fromRupees(h),
      low: fromRupees(l),
      close: fromRupees(c),
      volume,
    };
  }

  it('accepts a consistent bar', () => {
    expect(validateCandle(candle(100, 110, 95, 105)).valid).toBe(true);
  });

  it('rejects a high below the body', () => {
    expect(validateCandle(candle(100, 99, 95, 98)).rejections[0]!.code).toBe('INCONSISTENT_OHLC');
  });

  it('rejects a low above the body', () => {
    expect(validateCandle(candle(100, 110, 105, 108)).rejections[0]!.code).toBe(
      'INCONSISTENT_OHLC',
    );
  });

  it('rejects negative volume', () => {
    expect(validateCandle(candle(100, 110, 95, 105, -1)).rejections.map((r) => r.code)).toContain(
      'NEGATIVE_VOLUME',
    );
  });
});

describe('corporate actions', () => {
  function daily(timestamp: number, close: number, volume = 1000): Candle {
    return {
      symbol: 'NSE:RELIANCE',
      interval: '1d',
      timestamp,
      open: fromRupees(close),
      high: fromRupees(close),
      low: fromRupees(close),
      close: fromRupees(close),
      volume,
    };
  }

  it('divides pre-split prices by the split ratio', () => {
    expect(
      adjustmentFactor(
        { symbol: 'X', kind: 'SPLIT', exDate: 100, ratio: 10 },
        fromRupees(1000),
      ),
    ).toBeCloseTo(0.1, 10);
  });

  it('scales history by the dividend fraction', () => {
    const factor = adjustmentFactor(
      { symbol: 'X', kind: 'DIVIDEND', exDate: 100, amount: fromRupees(10) },
      fromRupees(1000),
    );
    expect(factor).toBeCloseTo(0.99, 10);
  });

  it('back-adjusts only the bars before the ex-date', () => {
    const candles = [daily(1, 1000), daily(2, 1000), daily(3, 100), daily(4, 105)];
    const adjusted = adjustForCorporateActions(candles, [
      { symbol: 'NSE:RELIANCE', kind: 'SPLIT', exDate: 3, ratio: 10 },
    ]);

    expect(adjusted[0]!.close).toBe(fromRupees(100));
    expect(adjusted[1]!.close).toBe(fromRupees(100));
    // On and after the ex-date, prices are already post-split and untouched.
    expect(adjusted[2]!.close).toBe(fromRupees(100));
    expect(adjusted[3]!.close).toBe(fromRupees(105));
  });

  it('scales volume inversely, keeping traded value continuous', () => {
    const candles = [daily(1, 1000, 100), daily(2, 100, 1000)];
    const adjusted = adjustForCorporateActions(candles, [
      { symbol: 'NSE:RELIANCE', kind: 'SPLIT', exDate: 2, ratio: 10 },
    ]);

    expect(adjusted[0]!.volume).toBe(1000);
  });

  it('compounds two actions applied to the same history', () => {
    const candles = [daily(1, 1000), daily(2, 500), daily(3, 250)];
    const adjusted = adjustForCorporateActions(candles, [
      { symbol: 'NSE:RELIANCE', kind: 'SPLIT', exDate: 2, ratio: 2 },
      { symbol: 'NSE:RELIANCE', kind: 'SPLIT', exDate: 3, ratio: 2 },
    ]);

    expect(adjusted[0]!.close).toBe(fromRupees(250));
    expect(adjusted[1]!.close).toBe(fromRupees(250));
    expect(adjusted[2]!.close).toBe(fromRupees(250));
  });

  it('ignores actions for a different symbol', () => {
    const candles = [daily(1, 1000), daily(2, 100)];
    const adjusted = adjustForCorporateActions(candles, [
      { symbol: 'NSE:TCS', kind: 'SPLIT', exDate: 2, ratio: 10 },
    ]);

    expect(adjusted[0]!.close).toBe(fromRupees(1000));
  });

  it('leaves an adjusted series free of unexplained gaps', () => {
    const candles = [daily(1, 1000), daily(2, 1000), daily(3, 100)];
    expect(findUnexplainedGaps(candles)).toHaveLength(1);

    const adjusted = adjustForCorporateActions(candles, [
      { symbol: 'NSE:RELIANCE', kind: 'SPLIT', exDate: 3, ratio: 10 },
    ]);
    expect(findUnexplainedGaps(adjusted)).toHaveLength(0);
  });

  it('rejects a split with no ratio', () => {
    expect(() =>
      adjustmentFactor({ symbol: 'X', kind: 'SPLIT', exDate: 1 }, fromRupees(100)),
    ).toThrow();
  });
});
