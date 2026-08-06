/**
 * CSV historical data provider.
 *
 * The other half of "load real NSE history": most usable long-range Indian
 * equity data arrives as a file, not an API, and a broker's historical endpoint
 * will not hand back five years of minute bars on a retail plan. This makes a
 * directory of CSVs a first-class source, so a five-year backtest does not
 * depend on having a live broker session.
 *
 * Expected columns, case-insensitive, in any order:
 *
 *     date (or timestamp/datetime), open, high, low, close, volume
 *
 * Dates may be epoch milliseconds, epoch seconds, `YYYY-MM-DD`, or a full ISO
 * timestamp. A bare date is interpreted as the IST session open, because a
 * daily bar timestamped at UTC midnight lands on the previous trading day in
 * IST — an off-by-one that would quietly shift every daily bar in the file.
 */

import { readFileSync } from 'node:fs';
import type { Candle, Interval, Timestamp } from '../domain/types';
import { fromRupees } from '../domain/money';
import { MarketDataError, type CandleQuery, type MarketDataProvider } from './provider';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** NSE equity session opens at 09:15 IST. */
const SESSION_OPEN_MS = (9 * 60 + 15) * 60 * 1000;

/** Splits a CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(current);
      current = '';
    } else current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parses a date cell to epoch milliseconds (UTC).
 *
 * Returns `null` rather than throwing so a trailing blank line or a footer row
 * is skipped instead of failing an otherwise good file.
 */
export function parseCsvTimestamp(raw: string): Timestamp | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // Ten digits is a second-precision epoch; thirteen is milliseconds.
    // Anything shorter is a year or a row number, not a timestamp.
    if (value.length >= 13) return n;
    if (value.length >= 10) return n * 1000;
    return null;
  }

  // A bare calendar date carries no timezone, so place it at the IST open.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const utcMidnight = Date.UTC(
      Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]),
    );
    return utcMidnight + SESSION_OPEN_MS - IST_OFFSET_MS;
  }

  // Same for `DD-MM-YYYY` and `DD/MM/YYYY`, common in Indian exports.
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(value);
  if (dmy) {
    const utcMidnight = Date.UTC(
      Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]),
    );
    return utcMidnight + SESSION_OPEN_MS - IST_OFFSET_MS;
  }

  // An ISO timestamp with no zone designator is IST, not UTC — these files are
  // exchange-local by convention.
  const naiveIso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value);
  const parsed = Date.parse(naiveIso ? `${value.replace(' ', 'T')}+05:30` : value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface CsvParseOptions {
  readonly symbol: string;
  readonly interval: Interval;
}

/** Parses CSV text into candles, oldest first. */
export function parseCandlesCsv(csv: string, options: CsvParseOptions): Candle[] {
  const lines = csv.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[\s_]/g, ''));

  const find = (...names: string[]): number => {
    for (const name of names) {
      const at = header.indexOf(name);
      if (at >= 0) return at;
    }
    return -1;
  };

  const dateAt = find('date', 'timestamp', 'datetime', 'time');
  const openAt = find('open', 'o');
  const highAt = find('high', 'h');
  const lowAt = find('low', 'l');
  const closeAt = find('close', 'c', 'closeprice');
  const volumeAt = find('volume', 'v', 'qty', 'quantity');

  const missing = [
    ['date', dateAt], ['open', openAt], ['high', highAt],
    ['low', lowAt], ['close', closeAt],
  ].filter(([, at]) => (at as number) < 0).map(([name]) => name);

  if (missing.length > 0) {
    throw new MarketDataError(`CSV is missing required column(s): ${missing.join(', ')}`, false);
  }

  const candles: Candle[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const timestamp = parseCsvTimestamp(cells[dateAt] ?? '');
    if (timestamp === null) continue;

    const price = (at: number): number | null => {
      const raw = cells[at]?.replace(/[₹,]/g, '').trim();
      // An empty cell must not become a zero price: `Number('')` is 0, which
      // would manufacture a bar at ₹0 that looks like real data to everything
      // downstream rather than like the missing value it is.
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    const open = price(openAt);
    const high = price(highAt);
    const low = price(lowAt);
    const close = price(closeAt);
    if (open === null || high === null || low === null || close === null) continue;

    const volume = volumeAt >= 0 ? price(volumeAt) : 0;

    candles.push({
      symbol: options.symbol,
      interval: options.interval,
      timestamp,
      open: fromRupees(open),
      high: fromRupees(high),
      low: fromRupees(low),
      close: fromRupees(close),
      volume: Math.max(0, Math.round(volume ?? 0)),
    });
  }

  // Exports are frequently newest-first; sorting means the caller need not know.
  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Serves candles from CSV files already on disk.
 *
 * Constructed with an explicit symbol→path map rather than scanning a directory
 * so that a missing file is an error naming the symbol, not a silently empty
 * backtest.
 */
export class CsvMarketDataProvider implements MarketDataProvider {
  readonly name = 'csv';

  private readonly cache = new Map<string, Candle[]>();

  constructor(private readonly files: ReadonlyMap<string, string>) {}

  static fromEntries(entries: readonly (readonly [string, string])[]): CsvMarketDataProvider {
    return new CsvMarketDataProvider(new Map(entries));
  }

  async fetchCandles(query: CandleQuery): Promise<Candle[]> {
    const key = `${query.symbol}|${query.interval}`;

    let candles = this.cache.get(key);
    if (!candles) {
      const path = this.files.get(query.symbol);
      if (!path) {
        throw new MarketDataError(`no CSV file configured for ${query.symbol}`, false);
      }

      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        throw new MarketDataError(
          `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
      }

      candles = parseCandlesCsv(text, { symbol: query.symbol, interval: query.interval });
      this.cache.set(key, candles);
    }

    return candles.filter((c) => c.timestamp >= query.from && c.timestamp <= query.to);
  }
}
