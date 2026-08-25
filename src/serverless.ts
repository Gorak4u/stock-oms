/**
 * Serverless composition.
 *
 * The same application as `main.ts`, assembled for an environment that runs it
 * per request instead of continuously. Nothing about the trading logic changes;
 * what changes is where state lives between invocations and what drives a tick.
 *
 * Three differences, and they are the whole of it:
 *
 * - **Nothing is held in memory between invocations.** Every entry point
 *   rebuilds the service from the database — which works because the pipeline's
 *   risk state (drawdown peak, day-open equity, staged approvals, the loss
 *   breaker) and the runner's square-off guard are all persisted. Before that
 *   they were not, and a serverless deployment would have reset the drawdown
 *   baseline on every tick, leaving the kill switches permanently inert.
 * - **The tick is pulled, not scheduled.** A cron request drives one iteration
 *   instead of a `setInterval`.
 * - **The single-writer guard is a lease, not an advisory lock.** There is no
 *   long-lived connection for a lock to live on.
 *
 * The honest trade: cron delivery is best-effort and each invocation pays the
 * cost of rebuilding state, so this is a weaker foundation than a process that
 * stays up. It is the right shape for paper trading, for a dashboard, and for
 * daily-bar strategies. For minute bars against real money, a process that
 * stays alive is the better tool.
 */

import { randomUUID } from 'node:crypto';
import { buildServer } from './api/server';
import { Database, databaseOptionsFromEnv } from './persistence/postgres';
import { TickLease } from './persistence/tickLease';
import { TradingService, type StrategyKind } from './runtime/tradingService';
import { LiveRunner } from './runtime/runner';
import { PaperBroker } from './execution/paperBroker';
import { ZerodhaBroker } from './execution/zerodhaBroker';
import { KiteSession } from './execution/kiteSession';
import type { BrokerConnector } from './execution/broker';
import { Reconciler } from './monitoring/reconciliation';
import { AlertManager, HealthMonitor, MetricsRegistry } from './monitoring/metrics';
import { buildCalendar, toIstDate } from './marketdata/calendar';
import { KiteHistoricalProvider } from './marketdata/kiteHistorical';
import { MarketDataIngestor, marketDataAge } from './marketdata/ingestion';
import type { MarketDataProvider } from './marketdata/provider';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from './risk/types';
import { fromRupees } from './domain/money';
import type { Interval } from './domain/types';
import type { FastifyInstance } from 'fastify';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${raw}`);
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function optionalList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function buildLimits(): RiskLimits {
  return {
    ...DEFAULT_RISK_LIMITS,
    riskPerTradeFraction: optionalNumber('RISK_PER_TRADE', DEFAULT_RISK_LIMITS.riskPerTradeFraction),
    maxPositionFraction: optionalNumber('MAX_POSITION', DEFAULT_RISK_LIMITS.maxPositionFraction),
    dailyLossLimitFraction: optionalNumber('DAILY_LOSS_LIMIT', DEFAULT_RISK_LIMITS.dailyLossLimitFraction),
    maxDrawdownFraction: optionalNumber('MAX_DRAWDOWN', DEFAULT_RISK_LIMITS.maxDrawdownFraction),
  };
}

export interface Assembled {
  readonly database: Database;
  readonly service: TradingService;
  readonly broker: BrokerConnector;
  readonly kiteSession: KiteSession | null;
  readonly ingestor: MarketDataIngestor | null;
  readonly lease: TickLease;
  readonly metrics: MetricsRegistry;
  readonly alerts: AlertManager;
  readonly health: HealthMonitor;
  readonly symbols: readonly string[];
  readonly barInterval: Interval;
}

/**
 * Builds everything from the environment and rebuilds state from the database.
 *
 * Cached across invocations that happen to reuse a warm container, because
 * migrating and replaying fills on every request would be both slow and
 * pointless. A cold start pays for it once.
 */
let cached: Promise<Assembled> | null = null;

export function assemble(): Promise<Assembled> {
  cached ??= build();
  return cached;
}

/** Drops the cache. Tests only — a warm container should keep its state. */
export function resetAssembly(): void {
  cached = null;
}

async function build(): Promise<Assembled> {
  const database = new Database(
    process.env.DATABASE_URL ?? required('POSTGRES_URL'),
    databaseOptionsFromEnv(),
  );

  await database.migrate();
  const repositories = database.repositories();

  const metrics = new MetricsRegistry();
  const alerts = new AlertManager();
  alerts.addSink((alert) => {
    console.log(JSON.stringify({ level: alert.severity, ...alert }));
  });

  const brokerMode = process.env.BROKER ?? 'paper';
  let kiteSession: KiteSession | null = null;
  let broker: BrokerConnector;

  if (brokerMode === 'zerodha') {
    const apiKey = required('KITE_API_KEY');
    kiteSession = new KiteSession({
      apiKey,
      state: repositories.state,
      alerts,
      ...(process.env.KITE_API_SECRET ? { apiSecret: process.env.KITE_API_SECRET } : {}),
    });
    await kiteSession.load(process.env.KITE_ACCESS_TOKEN);

    const session = kiteSession;
    broker = new ZerodhaBroker({
      apiKey,
      accessToken: () => session.accessToken(),
      onTokenRejected: (message) => void session.invalidate(message),
    });
  } else {
    // The paper broker keeps its resting orders, prices, cash and fills in
    // memory. A process that stays up carries that between ticks; an
    // invocation-per-tick environment does not, so an order submitted on one
    // tick is gone by the next and can never fill. Paper mode here is for
    // looking at seeded data, not for paper *trading*.
    console.log(JSON.stringify({
      level: 'warning',
      msg: 'paper broker on a serverless deployment — orders will not fill',
      detail:
        'The paper broker is in-memory, so it is rebuilt on every invocation. ' +
        'Seeded history displays correctly, but no new order can fill. Use ' +
        'BROKER=zerodha for a broker that holds its own state, or run the ' +
        'always-on process for paper trading.',
    }));
    broker = new PaperBroker({ openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)) });
  }

  const symbols = optionalList('SYMBOLS');
  const barInterval = (process.env.BAR_INTERVAL ?? '1d') as Interval;

  const service = new TradingService({
    repositories,
    broker,
    metrics,
    alerts,
    limits: buildLimits(),
    openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)),
    calendar: buildCalendar(process.env.NSE_HOLIDAYS),
    strategyKind: (process.env.STRATEGY as StrategyKind | undefined) ?? 'trend',
    symbols,
  });

  // Rebuilds the portfolio from fills and the risk state from its snapshot.
  await service.start();

  // See the same check in main.ts: an uncovered year reads as a permanently
  // closed market. Raised here on every cold start, which under this deployment
  // is the only startup there is.
  const today = toIstDate(Date.now());
  if (!service.calendar.isCovered(today)) {
    const covered = service.calendar.coveredYears?.join(', ') ?? 'none';
    void alerts.dispatch({
      severity: 'critical',
      title: 'Trading calendar is out of date',
      detail:
        `The holiday list covers ${covered}, not ${today.slice(0, 4)}. Every session reads as ` +
        'closed and no orders will be placed. Set NSE_HOLIDAYS to this year\'s NSE circular.',
      at: Date.now(),
    });
  }

  let provider: MarketDataProvider | null = null;
  if (kiteSession && brokerMode === 'zerodha') {
    const session = kiteSession;
    provider = new KiteHistoricalProvider({
      apiKey: required('KITE_API_KEY'),
      accessToken: () => session.accessToken(),
    });
  }

  const ingestor = provider
    ? new MarketDataIngestor({
        provider,
        candles: repositories.candles,
        state: repositories.state,
        metrics,
        alerts,
      })
    : null;

  const lease = new TickLease(database.pool, {
    ttlMs: optionalNumber('TICK_LEASE_MS', 120_000),
  });

  const health = new HealthMonitor();

  health.register('database', async () => {
    await database.pool.query('SELECT 1');
    return { status: 'healthy', detail: 'reachable' };
  });

  // See main.ts: an uncovered year means every session reads as closed.
  health.register('calendar', async () => {
    const date = toIstDate(Date.now());
    return service.calendar.isCovered(date)
      ? { status: 'healthy', detail: `holidays cover ${service.calendar.coveredYears?.join(', ') ?? 'every year'}` }
      : {
          status: 'unhealthy',
          detail: `no holiday list for ${date.slice(0, 4)} — set NSE_HOLIDAYS; trading is disabled`,
        };
  });

  health.register('broker', async () => {
    // Reported as degraded rather than healthy: the paper broker answers every
    // probe cheerfully while being unable to fill anything here, which is
    // exactly the kind of green light that hides an inert system.
    if (brokerMode !== 'zerodha') {
      return {
        status: 'degraded',
        detail: 'paper broker is in-memory — orders cannot fill on a per-invocation deployment',
      };
    }

    const healthy = await broker.isHealthy();
    return healthy
      ? { status: 'healthy', detail: broker.name }
      : { status: 'degraded', detail: `${broker.name} is not responding` };
  });

  health.register('audit-chain', async () => {
    const broken = service.audit.verifyChain();
    return broken === null
      ? { status: 'healthy', detail: 'chain intact' }
      : { status: 'unhealthy', detail: `chain broken at sequence ${broken}` };
  });

  /**
   * Whether ticks are actually arriving.
   *
   * The failure mode this catches is specific to a pulled tick: cron silently
   * stops, or was never configured, and nothing else notices — every other
   * check stays green while the system quietly does nothing. On a process that
   * schedules its own loop there is no equivalent.
   */
  health.register('tick', async () => {
    const held = await lease.current();
    if (!held) {
      return { status: 'degraded', detail: 'no tick has run yet — is the cron configured?' };
    }

    const sinceMs = Date.now() - held.expiresAt;
    const staleAfter = optionalNumber('TICK_STALE_MS', 30 * 60 * 1000);

    if (!service.calendar.isMarketOpen(Date.now())) {
      return { status: 'healthy', detail: 'market closed' };
    }
    return sinceMs > staleAfter
      ? { status: 'unhealthy', detail: `no tick for ${Math.round(sinceMs / 60_000)} minutes` }
      : { status: 'healthy', detail: 'ticking' };
  });

  if (kiteSession) {
    const session = kiteSession;
    health.register('broker-session', async () =>
      session.isValid
        ? { status: 'healthy', detail: `valid until ${new Date(session.expiresAt ?? 0).toISOString()}` }
        : { status: 'unhealthy', detail: `re-authentication required at ${session.loginUrl}` },
    );
  }

  if (symbols.length > 0) {
    const maxAgeMs = optionalNumber('MARKET_DATA_MAX_AGE_MS', 24 * 60 * 60 * 1000);
    health.register('market-data', async () => {
      const now = Date.now();
      if (!service.calendar.isMarketOpen(now)) {
        return { status: 'healthy', detail: 'market closed' };
      }
      const ages = await marketDataAge(repositories.candles, symbols, barInterval, now);
      const stale = ages.filter((a) => a.ageMs === null || a.ageMs > maxAgeMs);
      if (stale.length === 0) {
        return { status: 'healthy', detail: `${symbols.length} symbol(s) current` };
      }
      return {
        status: stale.length === symbols.length ? 'unhealthy' : 'degraded',
        detail: `stale market data — ${stale.map((s) => s.symbol).join(', ')}`,
      };
    });
  }

  return {
    database, service, broker, kiteSession, ingestor, lease,
    metrics, alerts, health, symbols, barInterval,
  };
}

/** The HTTP application, ready to be handed to a serverless adapter. */
export async function createApp(): Promise<FastifyInstance> {
  const assembled = await assemble();
  const { service, database, metrics, health, kiteSession } = assembled;

  const app = await buildServer({
    service,
    repositories: database.repositories(),
    metrics,
    health,
    authToken: required('API_TOKEN'),
    logger: false,
    publicReads: optionalBoolean('API_PUBLIC_READS', false),
    corsOrigins: optionalList('CORS_ORIGINS'),
    rateLimitPerMinute: optionalNumber('RATE_LIMIT_PER_MINUTE', 300),
    // The scheduler drives the loop here; there is no setInterval to own it.
    onTick: runTick,
    // Same guarantee as the leader lock on the always-on process, expressed the
    // way this deployment can: a lease held for the duration of the work. A
    // manual exit must not race a cron tick that is squaring off the very same
    // position.
    withTradingGuard: <T,>(fn: () => Promise<T>): Promise<T | null> =>
      assembled.lease.withLease(randomUUID(), fn),
    ...(process.env.CRON_SECRET ? { cronSecret: process.env.CRON_SECRET } : {}),
    ...(kiteSession
      ? {
          brokerSession: () => ({
            loginUrl: kiteSession.loginUrl,
            expiresAt: kiteSession.expiresAt,
            valid: kiteSession.isValid,
          }),
          onBrokerSession: async (input: {
            requestToken?: string; accessToken?: string; actor: string;
          }) => {
            if (input.requestToken) await kiteSession.exchangeRequestToken(input.requestToken);
            else if (input.accessToken) await kiteSession.adoptAccessToken(input.accessToken);
            return { expiresAt: kiteSession.expiresAt };
          },
        }
      : {}),
  });

  await app.ready();
  return app;
}

export interface TickReport {
  readonly ran: boolean;
  readonly reason?: string;
  readonly ingested?: number;
  readonly durationMs: number;
}

/**
 * One iteration, driven by an external scheduler.
 *
 * Ingests, then ticks the loop — the same order the always-on runner uses, so
 * the loop reads data written moments earlier rather than a stale table.
 * Everything runs under a lease: two overlapping cron deliveries must not both
 * decide, because that is two orders for one intent.
 */
export async function runTick(): Promise<TickReport> {
  const started = Date.now();
  const assembled = await assemble();
  const { service, ingestor, lease, symbols, barInterval, database, broker, alerts, metrics } = assembled;

  const owner = randomUUID();

  const result = await lease.withLease(owner, async () => {
    const repositories = database.repositories();
    let ingested = 0;

    if (ingestor && symbols.length > 0 && service.calendar.isMarketOpen(Date.now())) {
      const summaries = await ingestor.syncAll(symbols, barInterval);
      ingested = summaries.reduce((total, s) => total + s.stored, 0);
    }

    const runner = new LiveRunner({
      service,
      candles: repositories.candles,
      interval: barInterval,
      state: repositories.state,
      reconciler: new Reconciler({
        broker,
        orders: repositories.orders,
        fills: repositories.fills,
        breaks: repositories.reconciliation,
        portfolio: service.portfolio,
        alerts,
      }),
      alerts,
      // The lease is the guard here; a fresh runner has no reconcile history,
      // so reconciliation runs on every tick rather than on its own timer.
      reconcileIntervalMs: 0,
    });

    await runner.tick();
    metrics.setGauge('trading_last_tick_timestamp', Date.now());

    return ingested;
  });

  if (result === null) {
    return {
      ran: false,
      reason: 'another invocation holds the tick lease',
      durationMs: Date.now() - started,
    };
  }

  return { ran: true, ingested: result, durationMs: Date.now() - started };
}
