/**
 * The live trading loop.
 *
 * Ticks the pipeline once per bar during a session, reconciles periodically,
 * and squares off intraday positions before the close.
 *
 * The loop is driven by the market calendar rather than a bare interval: it
 * does nothing outside a session, which is both correct and the reason a
 * restart at 3am cannot place an order. It also refuses to run two ticks
 * concurrently — a slow broker call must not let the next tick start and
 * decide against a half-updated portfolio.
 */

import type { Interval, Timestamp } from '../domain/types';
import { toIstDate, type MarketCalendar } from '../marketdata/calendar';
import type { TradingService } from './tradingService';
import type { Reconciler } from '../monitoring/reconciliation';
import type { CandleRepository, RuntimeStateRepository } from '../persistence/ports';
import { METRICS, type AlertManager } from '../monitoring/metrics';

/** Where the square-off guard is kept between processes. */
const SQUARE_OFF_KEY = 'runner.squaredOffOn';

export interface RunnerConfig {
  readonly service: TradingService;
  readonly candles: CandleRepository;
  readonly reconciler?: Reconciler;
  readonly alerts?: AlertManager;
  /** How often to tick, in ms. One minute suits 1m bars. */
  readonly tickIntervalMs?: number;
  /** How often to reconcile against the broker, in ms. */
  readonly reconcileIntervalMs?: number;
  /**
   * Stop opening new positions this many minutes before the close, and square
   * off intraday positions. Brokers force-close MIS positions around 15:15,
   * usually at a worse price than a voluntary exit.
   */
  readonly squareOffMinutesBeforeClose?: number;
  /** Bars of history handed to the strategy each tick. */
  readonly historyBars?: number;
  /**
   * Bar size the loop trades on. Must match what ingestion is writing.
   *
   * Previously hardcoded to `1m` here while ingestion took its interval from
   * configuration, so raising the bar size wrote one series and read another:
   * the health check went green against fresh bars the strategy never saw, and
   * the loop ticked forever on an empty read.
   */
  readonly interval?: Interval;
  readonly clock?: () => Timestamp;
  /**
   * Durable store for the square-off guard.
   *
   * Optional so tests and single-run harnesses need not supply one; production
   * always should, or a restart late in the session duplicates exit orders.
   */
  readonly state?: RuntimeStateRepository;
  /**
   * Gate on whether this process may act.
   *
   * Wired to the leader lock in production: a follower still serves the API,
   * but must not decide or reconcile, because two processes acting on the same
   * account place two orders for one intent. Defaults to always-true so tests
   * and single-instance runs need not care.
   */
  readonly canTrade?: () => boolean;
}

export class LiveRunner {
  private readonly tickIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly squareOffMinutes: number;
  private readonly historyBars: number;
  private readonly interval: Interval;
  private readonly clock: () => Timestamp;
  private readonly calendar: MarketCalendar;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastReconcile = 0;
  /**
   * The IST date this loop has already squared off on.
   *
   * Persisted through {@link RunnerConfig.state}, because losing it is not a
   * cosmetic reset: square-off runs in the last twenty minutes of the session,
   * so a process that restarts in that window re-sends exit orders for every
   * open position, every tick, until the close.
   */
  private squaredOffOn = '';
  private running = false;
  /**
   * The tick currently in flight, if any.
   *
   * Held so shutdown can wait for it. A tick can be between "order persisted as
   * PENDING_NEW" and "broker acknowledged"; exiting there leaves an order whose
   * existence at the exchange is unknown until the next reconciliation. That is
   * recoverable, but it is not something to do on every ordinary deploy.
   */
  private inFlight: Promise<void> | null = null;

  constructor(private readonly config: RunnerConfig) {
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.reconcileIntervalMs = config.reconcileIntervalMs ?? 300_000;
    this.squareOffMinutes = config.squareOffMinutesBeforeClose ?? 20;
    this.historyBars = config.historyBars ?? 400;
    this.interval = config.interval ?? '1m';
    this.clock = config.clock ?? (() => Date.now());
    this.calendar = config.service.calendar;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  /**
   * Stops scheduling new ticks. Does not wait for one already running — see
   * {@link drain} for that.
   */
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Stops the loop and waits for any tick already in flight.
   *
   * `timeoutMs` bounds the wait so a wedged broker call cannot block shutdown
   * indefinitely — an orchestrator that gives up and sends SIGKILL is strictly
   * worse than exiting deliberately, because it forfeits the chance to close
   * the database cleanly. Resolves to whether the drain completed in time.
   */
  async drain(timeoutMs = 30_000): Promise<boolean> {
    this.stop();
    if (!this.inFlight) return true;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    try {
      // `inFlight` never rejects — tick() catches internally — so this settles
      // on whichever comes first without needing a catch.
      return await Promise.race([this.inFlight.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * One iteration. Public so tests and an operator can step it deterministically
   * instead of waiting on wall-clock intervals.
   */
  async tick(now: Timestamp = this.clock()): Promise<void> {
    // Re-entrancy guard: a tick that overran its interval must not have a
    // second one decide against a portfolio it is still updating.
    if (this.ticking) return;
    this.ticking = true;

    const run = this.runTick(now);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
      this.ticking = false;
    }
  }

  private async runTick(now: Timestamp): Promise<void> {
    try {
      // Checked every tick rather than once at start: leadership can be lost
      // mid-session if the database connection drops, and the loop must go
      // quiet the moment it is no longer the single writer.
      if (this.config.canTrade && !this.config.canTrade()) return;

      if (now - this.lastReconcile >= this.reconcileIntervalMs && this.config.reconciler) {
        this.lastReconcile = now;
        await this.reconcile(now);
      }

      if (!this.calendar.isMarketOpen(now)) return;

      const minutesToClose = this.calendar.minutesToClose(now);
      if (minutesToClose <= this.squareOffMinutes) {
        await this.squareOff(now);
        return;
      }

      for (const symbol of this.config.service.watchlist) {
        const history = await this.config.candles.latest(symbol, this.interval, this.historyBars);
        if (history.length < 60) continue;
        await this.config.service.onBar(symbol, history);
      }
    } catch (error) {
      await this.config.alerts?.dispatch({
        severity: 'critical',
        title: 'Trading loop error',
        detail: error instanceof Error ? error.message : String(error),
        at: now,
      });
    }
  }

  private async markSquaredOff(day: string, now: Timestamp): Promise<void> {
    this.squaredOffOn = day;
    await this.config.state?.set(SQUARE_OFF_KEY, day, now);
  }

  private async reconcile(now: Timestamp): Promise<void> {
    if (!this.config.reconciler) return;

    const since = now - 24 * 60 * 60 * 1000;
    const result = await this.config.reconciler.run(since, now);

    this.config.service.metrics.setGauge(METRICS.reconciliationBreaks, result.breaks.length);
  }

  /**
   * Closes intraday positions ahead of the broker's forced square-off.
   *
   * Runs once per session — tracked by IST date, because a repeat would send
   * duplicate exit orders every tick for the last twenty minutes of the day.
   */
  private async squareOff(now: Timestamp): Promise<void> {
    const today = toIstDate(now);
    if (this.squaredOffOn === today) return;

    // Consult the durable record too: this process may have restarted inside
    // the square-off window, in which case its in-memory guard is empty while
    // the exits have already gone out.
    const persisted = await this.config.state?.get<string>(SQUARE_OFF_KEY);
    if (persisted === today) {
      this.squaredOffOn = today;
      return;
    }

    const open = this.config.service.portfolio.getOpenPositions();
    if (open.length === 0) {
      await this.markSquaredOff(today, now);
      return;
    }

    // Recorded *before* sending, not after: a crash midway through would
    // otherwise re-send exits for the positions already closed.
    await this.markSquaredOff(today, now);

    await this.config.alerts?.dispatch({
      severity: 'info',
      title: 'Squaring off intraday positions',
      detail: `${open.length} position(s) ahead of the close`,
      at: now,
    });

    for (const position of open) {
      if (position.quantity === 0) continue;

      const request = this.config.service.oms.buildRequest(
        {
          strategyId: 'square-off',
          symbol: position.symbol,
          side: position.quantity > 0 ? 'SELL' : 'BUY',
          quantity: Math.abs(position.quantity),
          decisionBar: now,
        },
        { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' },
      );

      // Square-off is risk-reducing, so it bypasses the size controls by
      // construction (see RiskEngine) and goes straight to the OMS.
      await this.config.service.submitExit(request, `square-off-${today}`);
    }
  }
}
