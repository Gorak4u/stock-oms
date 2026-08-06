/**
 * Process entrypoint.
 *
 * Wires the layers together from environment configuration and starts the API,
 * market data ingestion and the trading loop.
 *
 * The startup order is deliberate:
 *
 * 1. Migrate, so the schema matches the code before anything reads it.
 * 2. Contend for leadership, because only one process may trade this account.
 * 3. Rebuild and reconcile state against the broker.
 * 4. Serve the API — a follower stops here, and that is a valid way to run.
 * 5. Ingest market data, then start the loop that consumes it.
 *
 * Starting the loop earlier would let it decide against a portfolio that had
 * not finished loading, or against candles that had not arrived. It also starts
 * in whatever automation mode was persisted, defaulting to MANUAL: a process
 * that came up in AUTOMATIC after a crash — trading before anyone had looked at
 * why it crashed — is a failure mode worth designing out.
 */

import Redis from 'ioredis';
import { buildServer } from './api/server';
import { Database, databaseOptionsFromEnv } from './persistence/postgres';
import { LeaderLock } from './persistence/leaderLock';
import { TradingService, type StrategyKind } from './runtime/tradingService';
import { LiveRunner } from './runtime/runner';
import { PaperBroker } from './execution/paperBroker';
import { ZerodhaBroker } from './execution/zerodhaBroker';
import { KiteSession } from './execution/kiteSession';
import type { BrokerConnector } from './execution/broker';
import { Reconciler } from './monitoring/reconciliation';
import { AlertManager, HealthMonitor, MetricsRegistry, METRICS } from './monitoring/metrics';
import { AlertDelivery } from './monitoring/alertDelivery';
import { MarketCalendar, NSE_HOLIDAYS_2026 } from './marketdata/calendar';
import { KiteHistoricalProvider } from './marketdata/kiteHistorical';
import { MarketDataIngestor, marketDataAge } from './marketdata/ingestion';
import type { MarketDataProvider } from './marketdata/provider';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from './risk/types';
import { fromRupees } from './domain/money';
import type { Interval } from './domain/types';

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

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ...extra, at: new Date().toISOString() }));
}

export async function main(): Promise<void> {
  const database = new Database(
    process.env.DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading',
    databaseOptionsFromEnv(),
  );

  const migrated = await database.migrate();
  log('info', 'schema migrated', {
    applied: migrated.applied, alreadyApplied: migrated.alreadyApplied.length,
  });

  const repositories = database.repositories();
  const metrics = new MetricsRegistry();
  const alerts = new AlertManager();

  alerts.addSink((alert) => {
    // Structured to stdout: a container's log stream is the one sink that is
    // always present, whatever else is configured.
    console.log(JSON.stringify({ level: alert.severity, ...alert }));
  });

  // ---- redis, alert delivery ----------------------------------------------

  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true })
    : null;

  let alertDelivery: AlertDelivery | null = null;
  if (redis && process.env.ALERT_WEBHOOK_URL) {
    alertDelivery = new AlertDelivery({
      redis,
      webhookUrl: process.env.ALERT_WEBHOOK_URL,
      metrics,
    });
    alerts.addSink(alertDelivery.sink());
    alertDelivery.start();
    log('info', 'durable alert delivery enabled');
  }

  // ---- broker --------------------------------------------------------------

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

    const hasToken = await kiteSession.load(process.env.KITE_ACCESS_TOKEN);
    if (!hasToken) {
      // Not fatal: the process still serves the API, which is the only way an
      // operator can supply the day's token. Refusing to start would make
      // recovery require a redeploy.
      log('warn', 'no valid Kite session — POST a request_token to /api/broker/session', {
        loginUrl: kiteSession.loginUrl,
      });
    }

    const session = kiteSession;
    broker = new ZerodhaBroker({
      apiKey,
      accessToken: () => session.accessToken(),
      onTokenRejected: (message) => void session.invalidate(message),
    });
  } else {
    // Paper is the default on purpose: reaching a live broker should require an
    // explicit, deliberate configuration change.
    broker = new PaperBroker({ openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)) });
  }

  // ---- service -------------------------------------------------------------

  const symbols = optionalList('SYMBOLS');
  const barInterval = (process.env.BAR_INTERVAL ?? '1m') as Interval;

  const service = new TradingService({
    repositories,
    broker,
    metrics,
    alerts,
    limits: buildLimits(),
    openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)),
    calendar: new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 }),
    strategyKind: (process.env.STRATEGY as StrategyKind | undefined) ?? 'trend',
    symbols,
  });

  // ---- leadership ----------------------------------------------------------

  const leader = new LeaderLock(database.pool, {
    onLost: (reason) => {
      metrics.setGauge(METRICS.isLeader, 0);
      void alerts.dispatch({
        severity: 'critical',
        title: 'Trading leadership lost',
        detail: `${reason}. This process has stopped trading; another instance may take over.`,
        at: Date.now(),
      });
    },
  });

  const isLeader = await leader.tryAcquire();
  metrics.setGauge(METRICS.isLeader, isLeader ? 1 : 0);

  if (!isLeader) {
    log('warn', 'another instance holds the trading lock — starting read-only');
  }

  // Rebuild and reconcile before anything can trade.
  await service.start();

  // ---- market data ---------------------------------------------------------

  let marketDataProvider: MarketDataProvider | null = null;
  if (kiteSession && brokerMode === 'zerodha') {
    const session = kiteSession;
    marketDataProvider = new KiteHistoricalProvider({
      apiKey: required('KITE_API_KEY'),
      // Resolved per call, so a token refreshed mid-session takes effect here
      // too. Throws when there is no session, which surfaces as a market-data
      // alert rather than as silently empty history.
      accessToken: () => session.accessToken(),
    });
  }

  const ingestor = marketDataProvider
    ? new MarketDataIngestor({
        provider: marketDataProvider,
        candles: repositories.candles,
        state: repositories.state,
        metrics,
        alerts,
      })
    : null;

  if (!ingestor) {
    log('warn', 'no market data provider configured — the trading loop has nothing to read', {
      hint: 'set BROKER=zerodha for live data, or backfill with `npm run backfill`',
    });
  }

  // ---- health --------------------------------------------------------------

  const health = new HealthMonitor();

  health.register('database', async () => {
    await database.pool.query('SELECT 1');
    return { status: 'healthy', detail: 'reachable' };
  });

  health.register('broker', async () => {
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

  health.register('leader', async () =>
    leader.isLeader
      ? { status: 'healthy', detail: 'holds the trading lock' }
      : { status: 'degraded', detail: 'read-only; another instance is trading' },
  );

  if (kiteSession) {
    const session = kiteSession;
    health.register('broker-session', async () =>
      session.isValid
        ? {
            status: 'healthy',
            detail: `token valid until ${new Date(session.expiresAt ?? 0).toISOString()}`,
          }
        : { status: 'unhealthy', detail: `re-authentication required at ${session.loginUrl}` },
    );
  }

  if (symbols.length > 0) {
    /**
     * Stale market data is reported as unhealthy during a session.
     *
     * This is the check that would have caught the platform's real failure
     * mode: a loop that ticks forever against an empty candle table looks
     * perfectly healthy by every other measure, because nothing is erroring —
     * there is simply nothing to decide on.
     */
    const maxAgeMs = optionalNumber('MARKET_DATA_MAX_AGE_MS', 15 * 60 * 1000);

    health.register('market-data', async () => {
      const now = Date.now();
      if (!service.calendar.isMarketOpen(now)) {
        return { status: 'healthy', detail: 'market closed' };
      }

      const ages = await marketDataAge(repositories.candles, symbols, barInterval, now);
      const stale = ages.filter((a) => a.ageMs === null || a.ageMs > maxAgeMs);

      if (stale.length === 0) return { status: 'healthy', detail: `${symbols.length} symbol(s) current` };

      const detail = stale
        .map((s) => `${s.symbol}: ${s.ageMs === null ? 'no data' : `${Math.round(s.ageMs / 1000)}s old`}`)
        .join(', ');

      // Unhealthy rather than degraded when every symbol is stale: the loop
      // cannot make a single decision, which is an outage however green the
      // rest of the checks look.
      return {
        status: stale.length === symbols.length ? 'unhealthy' : 'degraded',
        detail: `stale market data — ${detail}`,
      };
    });
  }

  if (redis) {
    health.register('redis', async () => {
      await redis.connect().catch(() => undefined);
      const pong = await redis.ping();
      return pong === 'PONG'
        ? { status: 'healthy', detail: 'reachable' }
        : { status: 'degraded', detail: 'unexpected ping response' };
    });
  }

  // ---- api -----------------------------------------------------------------

  const app = buildServer({
    service,
    repositories,
    metrics,
    health,
    authToken: required('API_TOKEN'),
    logger: process.env.NODE_ENV !== 'test',
    publicReads: optionalBoolean('API_PUBLIC_READS', false),
    corsOrigins: optionalList('CORS_ORIGINS'),
    rateLimitPerMinute: optionalNumber('RATE_LIMIT_PER_MINUTE', 300),
    ...(kiteSession
      ? {
          onBrokerSession: async (input: {
            requestToken?: string; accessToken?: string; actor: string;
          }) => {
            const session = kiteSession;
            if (input.requestToken) await session.exchangeRequestToken(input.requestToken);
            else if (input.accessToken) await session.adoptAccessToken(input.accessToken);
            log('info', 'broker session refreshed', { actor: input.actor });
            return { expiresAt: session.expiresAt };
          },
        }
      : {}),
  });

  const port = optionalNumber('PORT', 8080);
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
  log('info', 'api listening', {
    port, broker: broker.name, mode: service.status().mode, leader: isLeader,
  });

  // ---- loops ---------------------------------------------------------------

  const reconciler = new Reconciler({
    broker,
    orders: repositories.orders,
    fills: repositories.fills,
    breaks: repositories.reconciliation,
    portfolio: service.portfolio,
    alerts,
  });

  const runner = new LiveRunner({
    service,
    candles: repositories.candles,
    reconciler,
    alerts,
    canTrade: () => leader.isLeader,
  });

  /**
   * Market data sync, on its own timer.
   *
   * Separate from the trading loop rather than folded into its tick, so that a
   * slow provider delays data but never the decision to exit a position. The
   * loop reads whatever is in the table; ingestion's job is to keep that fresh.
   */
  let ingestTimer: NodeJS.Timeout | null = null;
  let ingesting = false;

  if (ingestor && symbols.length > 0) {
    const intervalMs = optionalNumber('MARKET_DATA_SYNC_MS', 60_000);

    const pump = async (): Promise<void> => {
      if (ingesting || !leader.isLeader) return;
      if (!service.calendar.isMarketOpen(Date.now())) return;

      ingesting = true;
      try {
        await ingestor.syncAll(symbols, barInterval);
      } finally {
        ingesting = false;
      }
    };

    // Once immediately so a restart mid-session does not wait a full interval
    // with stale data before the loop starts deciding.
    void pump();
    ingestTimer = setInterval(() => void pump(), intervalMs);
  }

  runner.start();

  // ---- shutdown ------------------------------------------------------------

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log('info', `${signal} received — draining before close`);

    if (ingestTimer) clearInterval(ingestTimer);

    // Wait for a tick already in flight. A tick can sit between "order
    // persisted as PENDING_NEW" and "broker acknowledged"; exiting there leaves
    // an order whose existence at the exchange is unknown until the next
    // reconciliation. Recoverable, but not worth doing on every deploy.
    const drained = await runner.drain(optionalNumber('SHUTDOWN_DRAIN_MS', 30_000));
    if (!drained) {
      log('warn', 'trading loop did not finish in time — a tick was still running');
    }

    await alertDelivery?.drain();
    await app.close();
    await leader.release();
    await database.close();
    if (redis) redis.disconnect();

    log('info', 'shutdown complete', { drained });
    process.exit(drained ? 0 : 1);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('failed to start', error);
    process.exit(1);
  });
}
