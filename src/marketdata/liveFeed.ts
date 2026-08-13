/**
 * Live market data: ticks in, bars in the `candle` table.
 *
 * The trading loop reads bars from the repository and knows nothing about where
 * they came from. This is the second thing that writes them — the first being
 * the historical ingestor — and the two have different jobs:
 *
 * - The **ingestor** backfills and repairs. It reads settled bars from Kite's
 *   historical endpoint, which is authoritative but always behind.
 * - This **feed** carries the current bar. It is the only source that can put a
 *   just-closed minute into the table while that minute still matters.
 *
 * They are deliberately not exclusive. The ingestor keeps running on its timer,
 * and because the repository upsert lets corrected data win, a bar this feed
 * assembled from ticks is later replaced by the exchange's own settled version.
 * That ordering is the point: trade on the fast copy, keep the accurate one.
 *
 * Bars are emitted on the first tick of the next bucket, by `CandleAggregator`,
 * so a stored tick stream replays to byte-identical candles. The session-close
 * flush exists because nothing ever arrives to open the bucket after the last
 * one of the day, and without it the closing bar would never be written.
 */

import type { Candle, Interval, Tick, Timestamp } from '../domain/types';
import type { CandleRepository } from '../persistence/ports';
import type { AlertManager, MetricsRegistry } from '../monitoring/metrics';
import { METRICS } from '../monitoring/metrics';
import { CandleAggregator } from './ohlc';
import { TickValidator } from './validation';
import { KiteTicker } from './kiteTicker';
import type { MarketCalendar } from './calendar';

export interface LiveFeedConfig {
  readonly ticker: KiteTicker;
  readonly candles: CandleRepository;
  readonly calendar: MarketCalendar;
  readonly interval: Interval;
  readonly metrics?: MetricsRegistry;
  readonly alerts?: AlertManager;
  /**
   * How often completed bars are written.
   *
   * Batched rather than written per bar: a hundred symbols crossing a minute
   * boundary together would otherwise be a hundred round trips inside the same
   * second the strategy wants to read them.
   */
  readonly flushIntervalMs?: number;
  /**
   * Largest tolerated move from the previous accepted price, as a fraction.
   *
   * A bad print reaches the strategy as a genuine signal and the risk engine as
   * a genuine mark, so the fat-finger guard belongs in front of the aggregator
   * rather than in front of the trader.
   */
  readonly maxMoveFraction?: number;
  readonly clock?: () => Timestamp;
}

/**
 * Turns a tick stream into stored candles.
 *
 * One aggregator and one validator per symbol: the validator is stateful — it
 * compares each tick against the previous one for that instrument — so sharing
 * it across symbols would compare Reliance against Infosys and reject both.
 */
export class LiveFeed {
  private readonly aggregators = new Map<string, CandleAggregator>();
  private readonly validators = new Map<string, TickValidator>();
  private pending: Candle[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private running = false;
  private bound = false;
  private lastSessionDate = '';
  private flushing: Promise<void> | null = null;

  private readonly flushIntervalMs: number;
  private readonly clock: () => Timestamp;

  constructor(private readonly config: LiveFeedConfig) {
    this.flushIntervalMs = config.flushIntervalMs ?? 5_000;
    this.clock = config.clock ?? (() => Date.now());
  }

  /** Bars assembled but not yet written. Exposed for the health check. */
  get pendingBars(): number {
    return this.pending.length;
  }

  /**
   * Starts streaming. Idempotent, and safe to call again after {@link stop} —
   * leadership changes hands mid-session, and a follower promoted at noon must
   * be able to start the feed the process stopped when it lost the lock.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Bound once, not per start: re-registering on every promotion would leave
    // one listener per cycle, each folding the same tick into the same bar.
    if (!this.bound) {
      this.bound = true;
      this.bind();
    }

    this.config.ticker.start();

    this.flushTimer = setInterval(() => {
      void this.tickFlush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private bind(): void {
    this.config.ticker.on('tick', (tick) => this.onTick(tick));

    this.config.ticker.on('connected', () => {
      this.config.metrics?.setGauge(METRICS.tickerConnected, 1);
    });

    this.config.ticker.on('disconnected', (reason) => {
      this.config.metrics?.setGauge(METRICS.tickerConnected, 0);
      this.config.metrics?.increment(METRICS.tickerReconnects);
      // Warning, not critical: the ticker reconnects on its own, and the
      // market-data health check already escalates when bars actually go stale.
      // Alerting critically on every blip would train an operator to ignore it.
      void this.config.alerts?.dispatch({
        severity: 'warning',
        title: 'Market data feed disconnected',
        detail: `${reason}. Reconnecting; bars will be stale until it recovers.`,
        at: this.clock(),
      });
    });

    this.config.ticker.on('error', (error) => {
      void this.config.alerts?.dispatch({
        severity: 'warning',
        title: 'Market data feed error',
        detail: error.message,
        at: this.clock(),
      });
    });
  }

  /**
   * Stops the feed and writes what it has.
   *
   * The in-progress bar is flushed too: on a deploy mid-session, discarding it
   * would leave a hole that the historical ingestor only fills on its next
   * pass, and the strategy would read across the gap in the meantime.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.config.ticker.stop();
    this.config.metrics?.setGauge(METRICS.tickerConnected, 0);

    this.closeOpenBars();
    await this.flush();
  }

  private onTick(tick: Tick): void {
    if (!this.running) return;

    // Ticks outside the session are real — pre-open order matching prints them
    // — but they are not part of any bar the strategy trades on, and folding
    // them in would give the first bar of the day an open from 09:07.
    if (!this.config.calendar.isMarketOpen(tick.timestamp)) return;

    const validator = this.validatorFor(tick.symbol);
    const result = validator.validate(tick, this.clock());
    if (!result.valid) {
      this.config.metrics?.increment(METRICS.tickerRejected);
      return;
    }

    this.config.metrics?.increment(METRICS.tickerTicks);
    this.config.metrics?.setGauge(METRICS.tickerLastTick, tick.timestamp);

    let completed: Candle | null;
    try {
      completed = this.aggregatorFor(tick.symbol).push(tick);
    } catch {
      // The aggregator rejects out-of-order ticks by throwing. Across a
      // reconnect that is expected rather than exceptional: the feed replays
      // from wherever the exchange resumed. Dropping the tick keeps the bar
      // that is already open intact.
      this.config.metrics?.increment(METRICS.tickerRejected);
      return;
    }

    if (completed) this.pending.push(completed);
  }

  /**
   * Closes every open bar at the end of the session.
   *
   * Driven from the flush timer rather than a scheduled job, so it happens
   * whether or not the process was up when the close came round.
   */
  private closeAtSessionEnd(): void {
    const now = this.clock();
    if (this.config.calendar.isMarketOpen(now)) return;

    // Only once per session, and only if there is a session to have ended.
    const previous = this.lastSessionDate;
    this.lastSessionDate = '';
    if (!previous) return;

    this.closeOpenBars();
  }

  private closeOpenBars(): void {
    for (const aggregator of this.aggregators.values()) {
      const bar = aggregator.flush();
      if (bar) this.pending.push(bar);
    }
  }

  private async tickFlush(): Promise<void> {
    const now = this.clock();
    if (this.config.calendar.isMarketOpen(now)) {
      this.lastSessionDate = new Date(now).toISOString().slice(0, 10);
    } else {
      this.closeAtSessionEnd();
    }

    await this.flush();
  }

  /**
   * Writes completed bars.
   *
   * Serialised against itself: two overlapping flushes would upsert the same
   * bars concurrently, and a slow write would let the pending array be cleared
   * out from under the one still running.
   */
  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];

    this.flushing = (async () => {
      try {
        const stored = await this.config.candles.upsertMany(batch);
        this.config.metrics?.increment(METRICS.marketDataBarsStored, {}, stored);

        const newest = batch.reduce((max, bar) => Math.max(max, bar.timestamp), 0);
        if (newest > 0) this.config.metrics?.setGauge(METRICS.marketDataLastBar, newest);
      } catch (error) {
        // Put them back. These bars exist nowhere else — the ticks that built
        // them are gone — so losing the batch on a transient database error
        // would leave a permanent hole in the series.
        this.pending = [...batch, ...this.pending];
        this.config.metrics?.increment(METRICS.marketDataErrors);

        void this.config.alerts?.dispatch({
          severity: 'warning',
          title: 'Could not store live bars',
          detail:
            `${error instanceof Error ? error.message : String(error)}. ` +
            `${this.pending.length} bar(s) held in memory for the next attempt.`,
          at: this.clock(),
        });
      } finally {
        this.flushing = null;
      }
    })();

    return this.flushing;
  }

  private aggregatorFor(symbol: string): CandleAggregator {
    let aggregator = this.aggregators.get(symbol);
    if (!aggregator) {
      aggregator = new CandleAggregator(symbol, this.config.interval);
      this.aggregators.set(symbol, aggregator);
    }
    return aggregator;
  }

  private validatorFor(symbol: string): TickValidator {
    let validator = this.validators.get(symbol);
    if (!validator) {
      validator = new TickValidator({
        ...(this.config.maxMoveFraction !== undefined
          ? { maxMoveFraction: this.config.maxMoveFraction }
          : {}),
      });
      this.validators.set(symbol, validator);
    }
    return validator;
  }
}
