/**
 * Kite Connect historical data provider.
 *
 * Two things make this more than a fetch wrapper.
 *
 * **Instrument tokens.** Kite's historical endpoint is keyed by a numeric
 * `instrument_token`, not by a trading symbol, and the mapping changes as
 * instruments are listed and delisted. The full dump is a several-megabyte CSV,
 * so it is fetched once and cached for the session.
 *
 * **Window limits.** Kite caps how much history one request may cover, and the
 * cap depends on the interval: 60 days for minute bars, 2000 for daily. A naive
 * five-year minute request returns an error, not a truncated result, so the
 * range is split into chunks the API will actually answer.
 *
 * Prices arrive as rupee floats and are converted at this boundary — nothing
 * downstream ever sees a float rupee.
 */

import type { Candle, Interval, Timestamp } from '../domain/types';
import { fromRupees } from '../domain/money';
import { MarketDataError, type CandleQuery, type MarketDataProvider } from './provider';

/** Kite's interval vocabulary, keyed by the platform's. */
const KITE_INTERVAL: Readonly<Record<Interval, string>> = {
  '1m': 'minute',
  '5m': '5minute',
  '15m': '15minute',
  '1h': '60minute',
  '1d': 'day',
};

/**
 * Maximum days of history Kite will return in one call, per interval.
 *
 * Taken from the Kite Connect documented limits, with a margin: requesting
 * exactly the cap occasionally errors on a boundary day, and one extra round
 * trip is cheaper than a failed backfill.
 */
const MAX_DAYS_PER_REQUEST: Readonly<Record<Interval, number>> = {
  '1m': 55,
  '5m': 90,
  '15m': 190,
  '1h': 380,
  '1d': 1900,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** IST is UTC+5:30 with no daylight saving — a fixed offset, unlike most zones. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface KiteHistoricalConfig {
  readonly apiKey: string;
  /**
   * The access token, or a function returning the current one.
   *
   * A function is what production passes: Kite tokens expire daily, and a
   * captured string would pin this provider to a token that goes stale every
   * morning — silently, since a failed sync only shows up as data going flat.
   */
  readonly accessToken: string | (() => string);
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Kite's historical endpoint is rate limited at ~3 requests/second. */
  readonly maxRequestsPerSecond?: number;
  readonly fetchImpl?: typeof fetch;
  /** Overrides the instrument dump, for tests and offline use. */
  readonly instruments?: InstrumentRecord[];
}

export interface InstrumentRecord {
  readonly instrumentToken: number;
  readonly tradingsymbol: string;
  readonly exchange: string;
  readonly segment: string;
  readonly lotSize: number;
  readonly tickSize: number;
}

interface KiteHistoricalResponse {
  status: string;
  message?: string;
  error_type?: string;
  data?: { candles: unknown[][] };
}

/**
 * Formats an epoch as Kite's expected `yyyy-mm-dd hh:mm:ss` in IST.
 *
 * Built by hand rather than via `toLocaleString` because the output of the
 * latter depends on the host's ICU data, and a backfill that silently shifts by
 * a day depending on where it runs is exactly the kind of bug that only shows
 * up in the numbers months later.
 */
export function toKiteTime(timestamp: Timestamp): string {
  const ist = new Date(timestamp + IST_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}` +
    ` ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`
  );
}

/**
 * Parses a Kite bar timestamp (`2024-01-01T09:15:00+0530`) to epoch ms.
 *
 * `Date.parse` rejects the `+0530` form without a colon in some runtimes, so
 * the offset is normalised first rather than trusted.
 */
export function parseKiteTime(raw: string): Timestamp {
  const normalised = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(normalised);
  if (Number.isNaN(parsed)) {
    throw new MarketDataError(`unparseable candle timestamp: ${raw}`, false);
  }
  return parsed;
}

/**
 * Parses the instruments CSV.
 *
 * Kite's dump is plain comma-separated with a header row and no quoted commas
 * in the fields used here, so a full CSV parser would be more machinery than
 * the format warrants. Rows that do not parse are skipped rather than fatal —
 * one malformed instrument out of ninety thousand must not stop a backfill.
 */
export function parseInstrumentsCsv(csv: string): InstrumentRecord[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0]!.split(',').map((h) => h.trim());
  const index = (name: string): number => header.indexOf(name);

  const tokenAt = index('instrument_token');
  const symbolAt = index('tradingsymbol');
  const exchangeAt = index('exchange');
  const segmentAt = index('segment');
  const lotAt = index('lot_size');
  const tickAt = index('tick_size');

  if (tokenAt < 0 || symbolAt < 0 || exchangeAt < 0) {
    throw new MarketDataError('instruments CSV is missing required columns', false);
  }

  const records: InstrumentRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',');
    const token = Number(cells[tokenAt]);
    const tradingsymbol = cells[symbolAt]?.trim();
    const exchange = cells[exchangeAt]?.trim();

    if (!Number.isFinite(token) || token <= 0 || !tradingsymbol || !exchange) continue;

    records.push({
      instrumentToken: token,
      tradingsymbol,
      exchange,
      segment: segmentAt >= 0 ? (cells[segmentAt]?.trim() ?? '') : '',
      lotSize: lotAt >= 0 ? Number(cells[lotAt]) || 1 : 1,
      tickSize: tickAt >= 0 ? Number(cells[tickAt]) || 0.05 : 0.05,
    });
  }

  return records;
}

/** Splits a range into windows the API will accept, oldest first. */
export function chunkRange(
  from: Timestamp,
  to: Timestamp,
  interval: Interval,
): { from: Timestamp; to: Timestamp }[] {
  const span = MAX_DAYS_PER_REQUEST[interval] * DAY_MS;
  const chunks: { from: Timestamp; to: Timestamp }[] = [];

  let cursor = from;
  while (cursor <= to) {
    const end = Math.min(cursor + span, to);
    chunks.push({ from: cursor, to: end });
    if (end === to) break;
    // +1ms so consecutive chunks cannot both contain the boundary bar. The
    // repository upsert would absorb a duplicate, but a double-counted bar in
    // an unrelated consumer would not be caught anywhere.
    cursor = end + 1;
  }

  return chunks;
}

/** Token bucket matching Kite's historical-endpoint rate limit. */
class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.perSecond,
        this.tokens + ((now - this.lastRefill) / 1000) * this.perSecond,
      );
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export class KiteHistoricalProvider implements MarketDataProvider {
  readonly name = 'kite-historical';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  /** Resolved lazily and cached: the dump is large and changes once a day. */
  private instruments: Map<string, InstrumentRecord> | null = null;

  constructor(private readonly config: KiteHistoricalConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.kite.trade';
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.limiter = new RateLimiter(config.maxRequestsPerSecond ?? 3);
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;

    if (!this.fetchImpl) throw new MarketDataError('no fetch implementation available', false);
    if (config.instruments) this.instruments = indexInstruments(config.instruments);
  }

  /** Resolved per request, so a token refreshed mid-session is picked up at once. */
  private accessToken(): string {
    const { accessToken } = this.config;
    return typeof accessToken === 'function' ? accessToken() : accessToken;
  }

  private headers(): Record<string, string> {
    return {
      'X-Kite-Version': '3',
      Authorization: `token ${this.config.apiKey}:${this.accessToken()}`,
    };
  }

  /** Fetches and caches the instrument dump. */
  async loadInstruments(force = false): Promise<Map<string, InstrumentRecord>> {
    if (this.instruments && !force) return this.instruments;

    await this.limiter.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/instruments`, {
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MarketDataError(
          `instrument dump failed: HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      const parsed = parseInstrumentsCsv(await response.text());
      if (parsed.length === 0) {
        throw new MarketDataError('instrument dump was empty', true);
      }

      this.instruments = indexInstruments(parsed);
      return this.instruments;
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        `instrument dump failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves `NSE:RELIANCE` to its Kite instrument token. */
  async resolveToken(symbol: string): Promise<number> {
    const instruments = await this.loadInstruments();
    const record = instruments.get(normaliseSymbol(symbol));
    if (!record) {
      throw new MarketDataError(`no Kite instrument matches ${symbol}`, false);
    }
    return record.instrumentToken;
  }

  async fetchCandles(query: CandleQuery): Promise<Candle[]> {
    const token = await this.resolveToken(query.symbol);
    const kiteInterval = KITE_INTERVAL[query.interval];

    const all: Candle[] = [];
    for (const chunk of chunkRange(query.from, query.to, query.interval)) {
      all.push(...(await this.fetchChunk(token, query, kiteInterval, chunk)));
    }

    // Chunks are requested in order, but a provider is not required to be
    // ordered within one; sort so downstream can rely on it.
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async fetchChunk(
    token: number,
    query: CandleQuery,
    kiteInterval: string,
    chunk: { from: Timestamp; to: Timestamp },
  ): Promise<Candle[]> {
    await this.limiter.acquire();

    const url =
      `${this.baseUrl}/instruments/historical/${token}/${kiteInterval}` +
      `?from=${encodeURIComponent(toKiteTime(chunk.from))}` +
      `&to=${encodeURIComponent(toKiteTime(chunk.to))}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.headers(), signal: controller.signal });
    } catch (error) {
      // Historical reads are pure, so a network failure is always safe to retry
      // — unlike an order submission, where the same failure is ambiguous.
      throw new MarketDataError(
        `historical fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: KiteHistoricalResponse;
    try {
      payload = (await response.json()) as KiteHistoricalResponse;
    } catch {
      throw new MarketDataError(`unparseable historical response (HTTP ${response.status})`, true);
    }

    if (!response.ok || payload.status === 'error') {
      const message = payload.message ?? `HTTP ${response.status}`;
      // A stale access token is fatal for this call but recoverable by the
      // operator, so it is flagged rather than retried into the rate limit.
      const fatal = payload.error_type === 'TokenException' || payload.error_type === 'InputException';
      throw new MarketDataError(
        `historical fetch failed: ${message}`,
        !fatal && (response.status === 429 || response.status >= 500),
      );
    }

    return (payload.data?.candles ?? []).map((row) =>
      toCandle(row, query.symbol, query.interval),
    );
  }
}

/**
 * Converts one `[time, o, h, l, c, volume]` row.
 *
 * Kite appends an open-interest column for derivatives; the extra field is
 * ignored rather than treated as a shape mismatch.
 */
function toCandle(row: unknown[], symbol: string, interval: Interval): Candle {
  if (row.length < 6) {
    throw new MarketDataError(`malformed candle row: ${JSON.stringify(row)}`, false);
  }

  const [time, open, high, low, close, volume] = row;

  const numeric = (value: unknown, field: string): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      throw new MarketDataError(`candle ${field} is not numeric: ${String(value)}`, false);
    }
    return n;
  };

  return {
    symbol,
    interval,
    timestamp: parseKiteTime(String(time)),
    open: fromRupees(numeric(open, 'open')),
    high: fromRupees(numeric(high, 'high')),
    low: fromRupees(numeric(low, 'low')),
    close: fromRupees(numeric(close, 'close')),
    volume: Math.max(0, Math.round(numeric(volume, 'volume'))),
  };
}

function normaliseSymbol(symbol: string): string {
  const index = symbol.indexOf(':');
  return index < 0 ? `NSE:${symbol.toUpperCase()}` : symbol.toUpperCase();
}

function indexInstruments(records: readonly InstrumentRecord[]): Map<string, InstrumentRecord> {
  const map = new Map<string, InstrumentRecord>();
  for (const record of records) {
    map.set(`${record.exchange.toUpperCase()}:${record.tradingsymbol.toUpperCase()}`, record);
  }
  return map;
}

export { KITE_INTERVAL, MAX_DAYS_PER_REQUEST };
