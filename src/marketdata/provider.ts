/**
 * Historical market data sources.
 *
 * The ingestion service depends on this interface, never on Kite. That is what
 * lets history be loaded from a CSV dump for backtesting and from the broker
 * for live operation, with the same validation, the same de-duplication and the
 * same watermark bookkeeping behind both.
 *
 * Providers return whatever they have. Everything about *trusting* the result —
 * validating OHLC consistency, rejecting bars outside the requested window,
 * deciding what to persist — belongs to the ingestor, so a new provider cannot
 * accidentally weaken those checks.
 */

import type { Candle, Interval, Timestamp } from '../domain/types';

export interface CandleQuery {
  readonly symbol: string;
  readonly interval: Interval;
  /** Inclusive lower bound. */
  readonly from: Timestamp;
  /** Inclusive upper bound. */
  readonly to: Timestamp;
}

export interface MarketDataProvider {
  readonly name: string;

  /**
   * Bars for the window, oldest first.
   *
   * May return fewer than requested — a holiday, a listing date after `from`, a
   * provider that caps a single response. The ingestor treats a short result as
   * information, not as an error.
   */
  fetchCandles(query: CandleQuery): Promise<Candle[]>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    /** Whether the same request may safely be retried. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}
