/**
 * Metrics, health checks and alerting.
 *
 * Prometheus text format, produced without a client library — the exposition
 * format is a few lines of text, and the platform's zero-dependency core is
 * worth more than the convenience.
 */

import type { Timestamp } from '../domain/types';

export type MetricKind = 'counter' | 'gauge' | 'histogram';

interface Labels {
  readonly [key: string]: string;
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Buckets in seconds, chosen for the latencies that matter: broker round trips. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramState {
  readonly buckets: number[];
  readonly counts: number[];
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramState>>();
  private readonly help = new Map<string, { kind: MetricKind; text: string }>();

  describe(name: string, kind: MetricKind, text: string): void {
    this.help.set(name, { kind, text });
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(labelKey(labels), value);
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}, buckets = DEFAULT_BUCKETS): void {
    const series = this.histograms.get(name) ?? new Map<string, HistogramState>();
    const key = labelKey(labels);

    let state = series.get(key);
    if (!state) {
      state = { buckets, counts: new Array<number>(buckets.length).fill(0), sum: 0, count: 0 };
      series.set(key, state);
    }

    state.sum += value;
    state.count += 1;
    for (let i = 0; i < state.buckets.length; i += 1) {
      if (value <= state.buckets[i]!) state.counts[i]! += 1;
    }

    this.histograms.set(name, series);
  }

  /** Times an async operation into a histogram, recording failures too. */
  async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.observe(name, (Date.now() - started) / 1000, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(name, (Date.now() - started) / 1000, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  /** Renders the Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    const emitHelp = (name: string, fallback: MetricKind): void => {
      const meta = this.help.get(name);
      lines.push(`# HELP ${name} ${meta?.text ?? name}`);
      lines.push(`# TYPE ${name} ${meta?.kind ?? fallback}`);
    };

    for (const [name, series] of this.counters) {
      emitHelp(name, 'counter');
      for (const [key, value] of series) {
        lines.push(`${name}${key ? `{${key}}` : ''} ${value}`);
      }
    }

    for (const [name, series] of this.gauges) {
      emitHelp(name, 'gauge');
      for (const [key, value] of series) {
        lines.push(`${name}${key ? `{${key}}` : ''} ${value}`);
      }
    }

    for (const [name, series] of this.histograms) {
      emitHelp(name, 'histogram');
      for (const [key, state] of series) {
        const prefix = key ? `${key},` : '';
        for (let i = 0; i < state.buckets.length; i += 1) {
          lines.push(`${name}_bucket{${prefix}le="${state.buckets[i]}"} ${state.counts[i]}`);
        }
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${state.count}`);
        lines.push(`${name}_sum${key ? `{${key}}` : ''} ${state.sum}`);
        lines.push(`${name}_count${key ? `{${key}}` : ''} ${state.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
  readonly durationMs: number;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheckResult[];
  readonly checkedAt: Timestamp;
}

export type HealthCheck = () => Promise<{ status: HealthStatus; detail: string }>;

/**
 * Runs registered health checks.
 *
 * A check that *throws* is unhealthy, not an error to propagate — a health
 * endpoint that 500s tells a load balancer nothing useful about which
 * dependency is broken.
 */
export class HealthMonitor {
  private readonly checks = new Map<string, HealthCheck>();

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  async run(): Promise<HealthReport> {
    const results = await Promise.all(
      [...this.checks.entries()].map(async ([name, check]): Promise<HealthCheckResult> => {
        const started = Date.now();
        try {
          const { status, detail } = await check();
          return { name, status, detail, durationMs: Date.now() - started };
        } catch (error) {
          return {
            name,
            status: 'unhealthy',
            detail: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          };
        }
      }),
    );

    // The worst individual result decides the overall status: one broken
    // dependency makes the system degraded even if everything else is fine.
    const status: HealthStatus = results.some((r) => r.status === 'unhealthy')
      ? 'unhealthy'
      : results.some((r) => r.status === 'degraded')
        ? 'degraded'
        : 'healthy';

    return { status, checks: results, checkedAt: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  readonly at: Timestamp;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type AlertSink = (alert: Alert) => Promise<void> | void;

/**
 * Dispatches alerts to every registered sink, with de-duplication.
 *
 * The same alert firing every tick is how operators learn to ignore alerts, so
 * a repeated title is suppressed within the cooldown — except for `critical`,
 * which always goes out. A silenced kill-switch alert is worse than a noisy one.
 */
export class AlertManager {
  private readonly sinks: AlertSink[] = [];
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly cooldownMs = 300_000) {}

  addSink(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  async dispatch(alert: Alert): Promise<boolean> {
    if (alert.severity !== 'critical') {
      const previous = this.lastSent.get(alert.title);
      if (previous !== undefined && alert.at - previous < this.cooldownMs) return false;
    }

    this.lastSent.set(alert.title, alert.at);

    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink(alert);
        } catch {
          // A failing sink (a down webhook) must not stop the others.
        }
      }),
    );

    return true;
  }
}

/** Metric names, centralised so the dashboard and the exporter cannot drift. */
export const METRICS = {
  ordersSubmitted: 'trading_orders_submitted_total',
  ordersRejected: 'trading_orders_rejected_total',
  fillsReceived: 'trading_fills_received_total',
  signalsGenerated: 'trading_signals_generated_total',
  riskRejections: 'trading_risk_rejections_total',
  brokerLatency: 'trading_broker_request_seconds',
  equity: 'trading_equity_paise',
  openPositions: 'trading_open_positions',
  dayPnl: 'trading_day_pnl_paise',
  drawdown: 'trading_drawdown_fraction',
  killSwitch: 'trading_kill_switch_engaged',
  queueDepth: 'trading_queue_depth',
  queueDeadLetters: 'trading_queue_dead_letters',
  reconciliationBreaks: 'trading_reconciliation_breaks_open',
  marketDataBarsStored: 'trading_market_data_bars_stored_total',
  marketDataRejected: 'trading_market_data_bars_rejected_total',
  marketDataErrors: 'trading_market_data_errors_total',
  /** Epoch ms of the newest stored bar. Alert on `time() - this` to catch a stalled feed. */
  marketDataLastBar: 'trading_market_data_last_bar_timestamp',
  isLeader: 'trading_is_leader',
  /** Live tick feed. A connected feed with zero ticks during a session is the failure to watch for. */
  tickerTicks: 'trading_ticker_ticks_total',
  tickerRejected: 'trading_ticker_ticks_rejected_total',
  tickerReconnects: 'trading_ticker_reconnects_total',
  tickerConnected: 'trading_ticker_connected',
  tickerLastTick: 'trading_ticker_last_tick_timestamp',
} as const;
