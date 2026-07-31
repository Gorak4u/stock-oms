/**
 * Process entrypoint.
 *
 * Wires the layers together from environment configuration and starts the API
 * and the trading loop.
 *
 * The startup order is deliberate: state is rebuilt and reconciled against the
 * broker *before* the trading loop starts. Starting the loop first would let
 * it decide against a portfolio that had not finished loading.
 *
 * It also starts in whatever automation mode was persisted, defaulting to
 * MANUAL. A process that came up in AUTOMATIC after a crash — trading before
 * anyone had looked at why it crashed — is a failure mode worth designing out.
 */

import Redis from 'ioredis';
import { buildServer } from './api/server';
import { Database } from './persistence/postgres';
import { TradingService, type StrategyKind } from './runtime/tradingService';
import { LiveRunner } from './runtime/runner';
import { PaperBroker } from './execution/paperBroker';
import { ZerodhaBroker } from './execution/zerodhaBroker';
import type { BrokerConnector } from './execution/broker';
import { Reconciler } from './monitoring/reconciliation';
import { AlertManager, HealthMonitor, MetricsRegistry } from './monitoring/metrics';
import { MarketCalendar, NSE_HOLIDAYS_2026 } from './marketdata/calendar';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from './risk/types';
import { fromRupees } from './domain/money';

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

function buildBroker(): BrokerConnector {
  const mode = process.env.BROKER ?? 'paper';

  if (mode === 'zerodha') {
    return new ZerodhaBroker({
      apiKey: required('KITE_API_KEY'),
      accessToken: required('KITE_ACCESS_TOKEN'),
    });
  }

  // Paper is the default on purpose: reaching a live broker should require an
  // explicit, deliberate configuration change.
  return new PaperBroker({ openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)) });
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

export async function main(): Promise<void> {
  const database = new Database(
    process.env.DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading',
  );
  await database.migrate();
  const repositories = database.repositories();

  const metrics = new MetricsRegistry();
  const alerts = new AlertManager();
  alerts.addSink((alert) => {
    // Structured to stdout: a container's log stream is the one sink that is
    // always present, whatever else is configured.
    console.log(JSON.stringify({ level: alert.severity, ...alert }));
  });

  const broker = buildBroker();
  const service = new TradingService({
    repositories,
    broker,
    metrics,
    alerts,
    limits: buildLimits(),
    openingCash: fromRupees(optionalNumber('OPENING_CASH', 1_000_000)),
    calendar: new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 }),
    strategyKind: (process.env.STRATEGY as StrategyKind | undefined) ?? 'trend',
    symbols: (process.env.SYMBOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  });

  // Rebuild and reconcile before anything can trade.
  await service.start();

  const reconciler = new Reconciler({
    broker,
    orders: repositories.orders,
    fills: repositories.fills,
    breaks: repositories.reconciliation,
    portfolio: service.portfolio,
    alerts,
  });

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

  if (process.env.REDIS_URL) {
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    health.register('redis', async () => {
      await redis.connect().catch(() => undefined);
      const pong = await redis.ping();
      return pong === 'PONG'
        ? { status: 'healthy', detail: 'reachable' }
        : { status: 'degraded', detail: 'unexpected ping response' };
    });
  }

  const app = buildServer({
    service,
    repositories,
    metrics,
    health,
    authToken: required('API_TOKEN'),
    logger: process.env.NODE_ENV !== 'test',
  });

  const port = optionalNumber('PORT', 8080);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API listening on :${port} (broker=${broker.name}, mode=${service.status().mode})`);

  const runner = new LiveRunner({ service, candles: repositories.candles, reconciler, alerts });
  runner.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received — stopping the trading loop before closing`);
    runner.stop();
    await app.close();
    await database.close();
    process.exit(0);
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
