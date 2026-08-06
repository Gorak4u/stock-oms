/**
 * Market data ingestion.
 *
 * This is the layer that was missing: the trading loop reads candles from the
 * repository, and until something writes them the loop is inert — it ticks,
 * finds no history, and decides nothing, forever, while looking perfectly
 * healthy. Everything here exists to keep the `candle` table current.
 *
 * Two modes, one code path:
 *
 * - **Backfill** — a bounded historical range, run once from a script.
 * - **Sync** — the recent window, run on a timer during a session.
 *
 * Both validate before persisting. A provider is an untrusted input in exactly
 * the way a tick feed is: a bar with a high below its low, a zero close from a
 * session rollover, or a stray future timestamp reaches the strategy as a
 * genuine signal and the risk engine as a genuine mark. Rejected bars are
 * counted and reported rather than dropped in silence, because a source that
 * starts failing validation is something an operator needs to know about while
 * it is happening, not afterwards from the P&L.
 */

import type { Candle, Interval, Timestamp } from '../domain/types';
import type { CandleRepository, RuntimeStateRepository } from '../persistence/ports';
import type { AlertManager, MetricsRegistry } from '../monitoring/metrics';
import { METRICS } from '../monitoring/metrics';
import { sanitiseCandles } from './validation';
import { MarketDataError, type MarketDataProvider } from './provider';

/** Watermark key per symbol and interval, so a restart resumes where it stopped. */
function watermarkKey(symbol: string, interval: Interval): string {
  return `marketdata:watermark:${interval}:${symbol}`;
}

export interface IngestionSummary {
  readonly symbol: string;
  readonly interval: Interval;
  readonly fetched: number;
  readonly stored: number;
  readonly rejected: number;
  /** Timestamp of the newest bar stored, or null when nothing was. */
  readonly latest: Timestamp | null;
}

export interface IngestorConfig {
  readonly provider: MarketDataProvider;
  readonly candles: CandleRepository;
  readonly state?: RuntimeStateRepository;
  readonly metrics?: MetricsRegistry;
  readonly alerts?: AlertManager;
  /**
   * How far back a sync re-reads on each pass.
   *
   * Deliberately longer than one bar: exchanges revise recent bars, and a
   * provider that was briefly unreachable leaves a hole that a strictly
   * forward-only sync would never come back for. The repository upsert makes
   * re-reading a settled bar free.
   */
  readonly syncLookbackMs?: number;
  readonly clock?: () => Timestamp;
}

export class MarketDataIngestor {
  private readonly syncLookbackMs: number;
  private readonly clock: () => Timestamp;

  constructor(private readonly config: IngestorConfig) {
    this.syncLookbackMs = config.syncLookbackMs ?? 2 * 60 * 60 * 1000;
    this.clock = config.clock ?? (() => Date.now());
  }

  /**
   * Loads a bounded historical range.
   *
   * Returns a summary rather than throwing on a partially good result: a
   * five-year backfill that got four and a half years is worth keeping, and the
   * caller can see exactly what arrived.
   */
  async backfill(
    symbol: string,
    interval: Interval,
    from: Timestamp,
    to: Timestamp = this.clock(),
  ): Promise<IngestionSummary> {
    if (from > to) {
      throw new MarketDataError(`backfill range is inverted: from=${from} to=${to}`, false);
    }

    const fetched = await this.config.provider.fetchCandles({ symbol, interval, from, to });
    return this.persist(symbol, interval, fetched);
  }

  /**
   * Brings a symbol up to date.
   *
   * Starts from the stored watermark when there is one, so a restart does not
   * re-read history it already has, and falls back to the lookback window on a
   * cold start.
   */
  async sync(symbol: string, interval: Interval): Promise<IngestionSummary> {
    const now = this.clock();
    const watermark = await this.readWatermark(symbol, interval);

    const from = watermark === null
      ? now - this.syncLookbackMs
      : Math.min(watermark, now - this.syncLookbackMs);

    const fetched = await this.config.provider.fetchCandles({ symbol, interval, from, to: now });
    return this.persist(symbol, interval, fetched);
  }

  /**
   * Syncs every symbol, isolating failures.
   *
   * One unreachable symbol — a delisting, a typo in the watchlist — must not
   * stop the others from updating, or a single bad entry silently freezes the
   * whole watchlist's data.
   */
  async syncAll(symbols: readonly string[], interval: Interval): Promise<IngestionSummary[]> {
    const summaries: IngestionSummary[] = [];

    for (const symbol of symbols) {
      try {
        summaries.push(await this.sync(symbol, interval));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.config.metrics?.increment(METRICS.marketDataErrors, { symbol });
        await this.config.alerts?.dispatch({
          severity: 'warning',
          title: 'Market data sync failed',
          detail: `${symbol}: ${detail}`,
          at: this.clock(),
          context: { symbol, interval },
        });
        summaries.push({ symbol, interval, fetched: 0, stored: 0, rejected: 0, latest: null });
      }
    }

    return summaries;
  }

  /** Validates, stores, and advances the watermark. */
  private async persist(
    symbol: string,
    interval: Interval,
    fetched: readonly Candle[],
  ): Promise<IngestionSummary> {
    const now = this.clock();

    // A provider must not decide what symbol or interval it is answering for —
    // a mislabelled bar would land in another symbol's series, where nothing
    // downstream could tell it apart from real data.
    const mismatched = fetched.filter((c) => c.symbol !== symbol || c.interval !== interval);
    if (mismatched.length > 0) {
      throw new MarketDataError(
        `provider ${this.config.provider.name} returned ${mismatched.length} bar(s) ` +
          `for a different symbol or interval than ${symbol}/${interval}`,
        false,
      );
    }

    // A bar timestamped in the future is a provider or clock fault. Admitting
    // one would let a strategy read a bar that has not finished forming, which
    // is lookahead introduced through the back door.
    const notFuture = fetched.filter((candle) => candle.timestamp <= now);
    const futureCount = fetched.length - notFuture.length;

    const { accepted, rejected } = sanitiseCandles(notFuture);
    const rejectedCount = rejected.length + futureCount;

    if (rejectedCount > 0) {
      this.config.metrics?.increment(METRICS.marketDataRejected, { symbol }, rejectedCount);

      const sample = rejected[0];
      await this.config.alerts?.dispatch({
        severity: 'warning',
        title: 'Market data validation rejected bars',
        detail:
          `${symbol}: ${rejectedCount} of ${fetched.length} bar(s) rejected` +
          (sample ? ` — e.g. ${sample.result.rejections.map((r) => r.code).join(', ')}` : '') +
          (futureCount > 0 ? ` (${futureCount} timestamped in the future)` : ''),
        at: now,
        context: { symbol, interval },
      });
    }

    const stored = accepted.length > 0 ? await this.config.candles.upsertMany(accepted) : 0;

    const latest = accepted.length > 0 ? accepted[accepted.length - 1]!.timestamp : null;
    if (latest !== null) {
      await this.writeWatermark(symbol, interval, latest, now);
      this.config.metrics?.setGauge(METRICS.marketDataLastBar, latest, { symbol });
    }

    this.config.metrics?.increment(METRICS.marketDataBarsStored, { symbol }, stored);

    return { symbol, interval, fetched: fetched.length, stored, rejected: rejectedCount, latest };
  }

  private async readWatermark(symbol: string, interval: Interval): Promise<Timestamp | null> {
    if (!this.config.state) return null;
    const stored = await this.config.state.get<number>(watermarkKey(symbol, interval));
    return typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
  }

  private async writeWatermark(
    symbol: string,
    interval: Interval,
    value: Timestamp,
    at: Timestamp,
  ): Promise<void> {
    await this.config.state?.set(watermarkKey(symbol, interval), value, at);
  }
}

/**
 * How stale a symbol's data is, for the health endpoint.
 *
 * Reported from the repository rather than from an in-memory counter so it
 * still tells the truth after a restart, and so it reflects what the strategy
 * will actually read rather than what ingestion believes it wrote.
 */
export async function marketDataAge(
  candles: CandleRepository,
  symbols: readonly string[],
  interval: Interval,
  now: Timestamp,
): Promise<{ symbol: string; latest: Timestamp | null; ageMs: number | null }[]> {
  return Promise.all(
    symbols.map(async (symbol) => {
      const [latest] = await candles.latest(symbol, interval, 1);
      return {
        symbol,
        latest: latest?.timestamp ?? null,
        ageMs: latest ? now - latest.timestamp : null,
      };
    }),
  );
}
