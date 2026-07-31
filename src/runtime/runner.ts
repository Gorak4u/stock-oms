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

import type { Timestamp } from '../domain/types';
import { toIstDate, type MarketCalendar } from '../marketdata/calendar';
import type { TradingService } from './tradingService';
import type { Reconciler } from '../monitoring/reconciliation';
import type { CandleRepository } from '../persistence/ports';
import { METRICS, type AlertManager } from '../monitoring/metrics';

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
  readonly clock?: () => Timestamp;
}

export class LiveRunner {
  private readonly tickIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly squareOffMinutes: number;
  private readonly historyBars: number;
  private readonly clock: () => Timestamp;
  private readonly calendar: MarketCalendar;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastReconcile = 0;
  private squaredOffOn = '';
  private running = false;

  constructor(private readonly config: RunnerConfig) {
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
    this.reconcileIntervalMs = config.reconcileIntervalMs ?? 300_000;
    this.squareOffMinutes = config.squareOffMinutesBeforeClose ?? 20;
    this.historyBars = config.historyBars ?? 400;
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

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

    try {
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
        const history = await this.config.candles.latest(symbol, '1m', this.historyBars);
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
    } finally {
      this.ticking = false;
    }
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

    const open = this.config.service.portfolio.getOpenPositions();
    if (open.length === 0) {
      this.squaredOffOn = today;
      return;
    }

    this.squaredOffOn = today;

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
      await this.config.service.oms.submit(request, `square-off-${today}`);
    }
  }
}
