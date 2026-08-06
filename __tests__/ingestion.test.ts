/**
 * Market data ingestion tests.
 *
 * The gap these cover is the one that made the whole platform inert: nothing
 * wrote candles, so the trading loop read an empty table forever while every
 * health check stayed green. The assertions here are therefore less about
 * happy-path plumbing and more about the ways ingestion can *appear* to work
 * while feeding the strategy layer nothing, or worse, feeding it garbage.
 */

import { MarketDataIngestor, marketDataAge } from '../src/marketdata/ingestion';
import {
  chunkRange,
  parseInstrumentsCsv,
  parseKiteTime,
  toKiteTime,
  KiteHistoricalProvider,
} from '../src/marketdata/kiteHistorical';
import { parseCandlesCsv, parseCsvTimestamp, CsvMarketDataProvider } from '../src/marketdata/csvProvider';
import { MarketDataError, type CandleQuery, type MarketDataProvider } from '../src/marketdata/provider';
import { memoryRepositories } from '../src/persistence/memory';
import { MetricsRegistry, AlertManager, type Alert } from '../src/monitoring/metrics';
import { fromRupees } from '../src/domain/money';
import type { Candle, Interval } from '../src/domain/types';

const MINUTE = 60_000;

function candle(ts: number, close: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: 'NSE:TEST',
    interval: '1m',
    timestamp: ts,
    open: fromRupees(close),
    high: fromRupees(close + 1),
    low: fromRupees(close - 1),
    close: fromRupees(close),
    volume: 1_000,
    ...overrides,
  };
}

/** A provider that returns exactly what it is given. */
class StubProvider implements MarketDataProvider {
  readonly name = 'stub';
  readonly queries: CandleQuery[] = [];

  constructor(private candles: Candle[] = [], private error?: Error) {}

  setCandles(candles: Candle[]): void {
    this.candles = candles;
  }

  async fetchCandles(query: CandleQuery): Promise<Candle[]> {
    this.queries.push(query);
    if (this.error) throw this.error;
    return this.candles.filter((c) => c.timestamp >= query.from && c.timestamp <= query.to);
  }
}

describe('MarketDataIngestor', () => {
  const now = 1_700_000_000_000;

  function build(provider: MarketDataProvider, options: { alerts?: AlertManager } = {}) {
    const repositories = memoryRepositories();
    const metrics = new MetricsRegistry();
    const ingestor = new MarketDataIngestor({
      provider,
      candles: repositories.candles,
      state: repositories.state,
      metrics,
      clock: () => now,
      ...(options.alerts ? { alerts: options.alerts } : {}),
    });
    return { repositories, metrics, ingestor };
  }

  describe('backfill', () => {
    it('stores fetched bars', async () => {
      const bars = [candle(now - 3 * MINUTE, 100), candle(now - 2 * MINUTE, 101)];
      const { ingestor, repositories } = build(new StubProvider(bars));

      const summary = await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now);

      expect(summary.stored).toBe(2);
      expect(summary.rejected).toBe(0);
      expect(summary.latest).toBe(now - 2 * MINUTE);
      expect(await repositories.candles.latest('NSE:TEST', '1m', 10)).toHaveLength(2);
    });

    it('refuses an inverted range', async () => {
      const { ingestor } = build(new StubProvider([]));
      await expect(ingestor.backfill('NSE:TEST', '1m', now, now - MINUTE)).rejects.toThrow(
        /inverted/,
      );
    });

    it('is idempotent — re-running replaces rather than duplicates', async () => {
      const bars = [candle(now - MINUTE, 100)];
      const { ingestor, repositories } = build(new StubProvider(bars));

      await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now);
      await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now);

      expect(await repositories.candles.latest('NSE:TEST', '1m', 10)).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('rejects bars whose high is below their low', async () => {
      const broken = candle(now - MINUTE, 100, {
        high: fromRupees(90), low: fromRupees(110),
      });
      const { ingestor, repositories } = build(new StubProvider([broken, candle(now - 2 * MINUTE, 100)]));

      const summary = await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now);

      expect(summary.rejected).toBe(1);
      expect(summary.stored).toBe(1);
      expect(await repositories.candles.latest('NSE:TEST', '1m', 10)).toHaveLength(1);
    });

    it('rejects a bar timestamped in the future', async () => {
      // Lookahead through the back door: a strategy reading a bar that has not
      // finished forming is reading the future, however it got there.
      const { ingestor, repositories } = build(
        new StubProvider([candle(now + 5 * MINUTE, 100), candle(now - MINUTE, 100)]),
      );

      const summary = await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now + 10 * MINUTE);

      expect(summary.rejected).toBe(1);
      expect(summary.stored).toBe(1);
      const stored = await repositories.candles.latest('NSE:TEST', '1m', 10);
      expect(stored.every((c) => c.timestamp <= now)).toBe(true);
    });

    it('refuses bars labelled with a different symbol', async () => {
      const { ingestor } = build(
        new StubProvider([candle(now - MINUTE, 100, { symbol: 'NSE:OTHER' })]),
      );

      await expect(
        ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now),
      ).rejects.toThrow(/different symbol or interval/);
    });

    it('refuses bars labelled with a different interval', async () => {
      const { ingestor } = build(
        new StubProvider([candle(now - MINUTE, 100, { interval: '1d' })]),
      );

      await expect(
        ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now),
      ).rejects.toThrow(/different symbol or interval/);
    });

    it('alerts when bars are rejected', async () => {
      const received: Alert[] = [];
      const alerts = new AlertManager();
      alerts.addSink((alert) => void received.push(alert));

      const broken = candle(now - MINUTE, 100, { close: fromRupees(0) });
      const { ingestor } = build(new StubProvider([broken]), { alerts });

      await ingestor.backfill('NSE:TEST', '1m', now - 10 * MINUTE, now);

      expect(received).toHaveLength(1);
      expect(received[0]?.title).toMatch(/validation rejected/i);
    });
  });

  describe('sync', () => {
    it('reads back from the lookback window on a cold start', async () => {
      const provider = new StubProvider([]);
      const { ingestor } = build(provider);

      await ingestor.sync('NSE:TEST', '1m');

      expect(provider.queries[0]?.to).toBe(now);
      expect(provider.queries[0]?.from).toBeLessThan(now);
    });

    it('advances a watermark and re-reads recent bars on the next pass', async () => {
      const provider = new StubProvider([candle(now - MINUTE, 100)]);
      const { ingestor, repositories } = build(provider);

      await ingestor.sync('NSE:TEST', '1m');
      const watermark = await repositories.state.get<number>('marketdata:watermark:1m:NSE:TEST');
      expect(watermark).toBe(now - MINUTE);

      await ingestor.sync('NSE:TEST', '1m');

      // Re-reads a window rather than resuming strictly after the watermark:
      // exchanges revise recent bars, and a gap from a brief outage would
      // otherwise never be filled.
      expect(provider.queries[1]?.from).toBeLessThanOrEqual(watermark!);
    });

    it('isolates one symbol failing from the rest', async () => {
      const failing: MarketDataProvider = {
        name: 'failing',
        async fetchCandles(query) {
          if (query.symbol === 'NSE:BAD') throw new MarketDataError('delisted', false);
          return [candle(now - MINUTE, 100, { symbol: query.symbol })];
        },
      };

      const { ingestor, repositories } = build(failing);
      const summaries = await ingestor.syncAll(['NSE:BAD', 'NSE:GOOD'], '1m');

      expect(summaries).toHaveLength(2);
      expect(summaries[0]?.stored).toBe(0);
      expect(summaries[1]?.stored).toBe(1);
      expect(await repositories.candles.latest('NSE:GOOD', '1m', 10)).toHaveLength(1);
    });
  });

  describe('marketDataAge', () => {
    it('reports null for a symbol with no data', async () => {
      const repositories = memoryRepositories();
      const ages = await marketDataAge(repositories.candles, ['NSE:TEST'], '1m', now);
      expect(ages[0]?.latest).toBeNull();
      expect(ages[0]?.ageMs).toBeNull();
    });

    it('reports the age of the newest bar', async () => {
      const repositories = memoryRepositories();
      await repositories.candles.upsertMany([candle(now - 5 * MINUTE, 100)]);

      const ages = await marketDataAge(repositories.candles, ['NSE:TEST'], '1m', now);
      expect(ages[0]?.ageMs).toBe(5 * MINUTE);
    });
  });
});

// ===========================================================================
// Kite historical provider
// ===========================================================================

describe('Kite historical', () => {
  describe('time conversion', () => {
    it('formats an epoch as IST wall-clock', () => {
      // 2024-01-01T03:45:00Z is 09:15 IST — the NSE session open.
      expect(toKiteTime(Date.parse('2024-01-01T03:45:00Z'))).toBe('2024-01-01 09:15:00');
    });

    it('parses Kite offsets without a colon', () => {
      expect(parseKiteTime('2024-01-01T09:15:00+0530')).toBe(Date.parse('2024-01-01T03:45:00Z'));
    });

    it('round-trips', () => {
      const original = Date.parse('2024-06-14T05:30:00Z');
      expect(parseKiteTime(`${toKiteTime(original).replace(' ', 'T')}+0530`)).toBe(original);
    });

    it('rejects an unparseable timestamp', () => {
      expect(() => parseKiteTime('not-a-date')).toThrow(MarketDataError);
    });
  });

  describe('chunkRange', () => {
    it('returns a single chunk when the range fits', () => {
      const from = Date.parse('2024-01-01T00:00:00Z');
      const to = Date.parse('2024-01-10T00:00:00Z');
      expect(chunkRange(from, to, '1m')).toHaveLength(1);
    });

    it('splits a range that exceeds the per-request cap', () => {
      const from = Date.parse('2020-01-01T00:00:00Z');
      const to = Date.parse('2024-01-01T00:00:00Z');

      const chunks = chunkRange(from, to, '1m');
      expect(chunks.length).toBeGreaterThan(20);
      expect(chunks[0]?.from).toBe(from);
      expect(chunks[chunks.length - 1]?.to).toBe(to);
    });

    it('produces non-overlapping, gapless chunks', () => {
      const from = Date.parse('2022-01-01T00:00:00Z');
      const to = Date.parse('2024-01-01T00:00:00Z');

      const chunks = chunkRange(from, to, '1m');
      for (let i = 1; i < chunks.length; i += 1) {
        expect(chunks[i]!.from).toBe(chunks[i - 1]!.to + 1);
      }
    });

    it('uses a wider window for daily bars than for minute bars', () => {
      const from = Date.parse('2020-01-01T00:00:00Z');
      const to = Date.parse('2024-01-01T00:00:00Z');
      expect(chunkRange(from, to, '1d').length).toBeLessThan(chunkRange(from, to, '1m').length);
    });
  });

  describe('parseInstrumentsCsv', () => {
    const csv = [
      'instrument_token,exchange_token,tradingsymbol,name,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
      '738561,2885,RELIANCE,RELIANCE INDUSTRIES,,0,0.05,1,EQ,NSE,NSE',
      '2953217,11533,TCS,TATA CONSULTANCY,,0,0.05,1,EQ,NSE,NSE',
    ].join('\n');

    it('extracts instrument tokens', () => {
      const records = parseInstrumentsCsv(csv);
      expect(records).toHaveLength(2);
      expect(records[0]?.instrumentToken).toBe(738561);
      expect(records[0]?.tradingsymbol).toBe('RELIANCE');
    });

    it('skips malformed rows rather than failing the dump', () => {
      const records = parseInstrumentsCsv(`${csv}\n,,,,,,,,,,\nnot,a,row`);
      expect(records).toHaveLength(2);
    });

    it('throws when required columns are absent', () => {
      expect(() => parseInstrumentsCsv('a,b,c\n1,2,3')).toThrow(MarketDataError);
    });
  });

  describe('fetchCandles', () => {
    const instruments = [
      { instrumentToken: 738561, tradingsymbol: 'RELIANCE', exchange: 'NSE', segment: 'NSE', lotSize: 1, tickSize: 0.05 },
    ];

    function provider(fetchImpl: typeof fetch): KiteHistoricalProvider {
      return new KiteHistoricalProvider({
        apiKey: 'key', accessToken: 'token', fetchImpl, instruments,
        maxRequestsPerSecond: 1000,
      });
    }

    it('converts rupee floats to integer paise', async () => {
      const fetchImpl = jest.fn(async () =>
        new Response(JSON.stringify({
          status: 'success',
          data: { candles: [['2024-01-01T09:15:00+0530', 2500.55, 2510.1, 2495.25, 2505.75, 12345]] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ) as unknown as typeof fetch;

      const [bar] = await provider(fetchImpl).fetchCandles({
        symbol: 'NSE:RELIANCE', interval: '1d',
        from: Date.parse('2024-01-01T00:00:00Z'), to: Date.parse('2024-01-02T00:00:00Z'),
      });

      expect(bar?.open).toBe(250055);
      expect(bar?.high).toBe(251010);
      expect(bar?.close).toBe(250575);
      expect(bar?.volume).toBe(12345);
      expect(bar?.symbol).toBe('NSE:RELIANCE');
    });

    it('fails on an unknown symbol rather than returning nothing', async () => {
      const fetchImpl = jest.fn() as unknown as typeof fetch;
      await expect(
        provider(fetchImpl).fetchCandles({
          symbol: 'NSE:NOSUCH', interval: '1d', from: 0, to: 1,
        }),
      ).rejects.toThrow(/no Kite instrument/);
    });

    it('marks a 5xx as retryable and a token failure as not', async () => {
      const serverError = jest.fn(async () =>
        new Response(JSON.stringify({ status: 'error', message: 'boom' }), { status: 503 }),
      ) as unknown as typeof fetch;

      await expect(
        provider(serverError).fetchCandles({ symbol: 'NSE:RELIANCE', interval: '1d', from: 0, to: 1 }),
      ).rejects.toMatchObject({ retryable: true });

      const tokenError = jest.fn(async () =>
        new Response(
          JSON.stringify({ status: 'error', message: 'token expired', error_type: 'TokenException' }),
          { status: 403 },
        ),
      ) as unknown as typeof fetch;

      await expect(
        provider(tokenError).fetchCandles({ symbol: 'NSE:RELIANCE', interval: '1d', from: 0, to: 1 }),
      ).rejects.toMatchObject({ retryable: false });
    });

    it('resolves the access token per request', async () => {
      let token = 'first';
      const seen: string[] = [];

      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ status: 'success', data: { candles: [] } }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      const p = new KiteHistoricalProvider({
        apiKey: 'key', accessToken: () => token, fetchImpl, instruments,
        maxRequestsPerSecond: 1000,
      });

      await p.fetchCandles({ symbol: 'NSE:RELIANCE', interval: '1d', from: 0, to: 1 });
      token = 'second';
      await p.fetchCandles({ symbol: 'NSE:RELIANCE', interval: '1d', from: 0, to: 1 });

      expect(seen[0]).toContain('first');
      expect(seen[1]).toContain('second');
    });
  });
});

// ===========================================================================
// CSV provider
// ===========================================================================

describe('CSV provider', () => {
  describe('parseCsvTimestamp', () => {
    it('reads a bare date as the IST session open', () => {
      // Not UTC midnight: that lands on the previous trading day in IST, which
      // would shift every daily bar in the file by one session.
      expect(parseCsvTimestamp('2024-01-01')).toBe(Date.parse('2024-01-01T09:15:00+05:30'));
    });

    it('reads DD-MM-YYYY, common in Indian exports', () => {
      expect(parseCsvTimestamp('15-08-2024')).toBe(Date.parse('2024-08-15T09:15:00+05:30'));
    });

    it('reads epoch seconds and milliseconds', () => {
      expect(parseCsvTimestamp('1700000000')).toBe(1_700_000_000_000);
      expect(parseCsvTimestamp('1700000000000')).toBe(1_700_000_000_000);
    });

    it('treats a zoneless ISO timestamp as IST', () => {
      expect(parseCsvTimestamp('2024-01-01T09:15:00')).toBe(Date.parse('2024-01-01T09:15:00+05:30'));
    });

    it('returns null for junk', () => {
      expect(parseCsvTimestamp('')).toBeNull();
      expect(parseCsvTimestamp('total')).toBeNull();
    });
  });

  describe('parseCandlesCsv', () => {
    const options = { symbol: 'NSE:TEST', interval: '1d' as Interval };

    it('parses a standard export', () => {
      const csv = [
        'Date,Open,High,Low,Close,Volume',
        '2024-01-01,100.5,105.25,99.75,104,50000',
        '2024-01-02,104,108,103.5,107.25,61000',
      ].join('\n');

      const candles = parseCandlesCsv(csv, options);
      expect(candles).toHaveLength(2);
      expect(candles[0]?.open).toBe(10050);
      expect(candles[0]?.close).toBe(10400);
      expect(candles[1]?.volume).toBe(61000);
    });

    it('sorts a newest-first export into oldest-first', () => {
      const csv = [
        'date,open,high,low,close,volume',
        '2024-01-03,3,3,3,3,1',
        '2024-01-01,1,1,1,1,1',
        '2024-01-02,2,2,2,2,1',
      ].join('\n');

      const candles = parseCandlesCsv(csv, options);
      expect(candles.map((c) => c.close)).toEqual([100, 200, 300]);
    });

    it('tolerates header case, spacing and currency symbols', () => {
      const csv = ['DATE, OPEN , High,LOW,Close , VOLUME', '2024-01-01,₹1,200,"1,0",1,5'].join('\n');
      expect(() => parseCandlesCsv(csv, options)).not.toThrow();
    });

    it('skips rows with unparseable prices rather than failing the file', () => {
      const csv = [
        'date,open,high,low,close,volume',
        '2024-01-01,1,1,1,1,1',
        '2024-01-02,,,,,',
        '2024-01-03,3,3,3,3,1',
      ].join('\n');

      expect(parseCandlesCsv(csv, options)).toHaveLength(2);
    });

    it('names the missing column when one is absent', () => {
      const csv = 'date,open,high,low\n2024-01-01,1,1,1';
      expect(() => parseCandlesCsv(csv, options)).toThrow(/close/);
    });
  });

  describe('CsvMarketDataProvider', () => {
    it('names the symbol when no file is configured', async () => {
      const provider = CsvMarketDataProvider.fromEntries([]);
      await expect(
        provider.fetchCandles({ symbol: 'NSE:TEST', interval: '1d', from: 0, to: 1 }),
      ).rejects.toThrow(/NSE:TEST/);
    });
  });
});
