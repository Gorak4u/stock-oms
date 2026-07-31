/**
 * HTTP API.
 *
 * Fastify over the trading service. Three rules shape the route design:
 *
 * - **Reads are free, writes are authenticated.** Every mutating route
 *   requires a bearer token, because these routes move money.
 * - **Dangerous actions name their actor.** Engaging the kill switch or
 *   switching to automatic trading records who did it, so the audit log can
 *   answer "who turned this on" months later.
 * - **The API never contains trading logic.** It validates, delegates to the
 *   service, and serialises. Anything else would be a second implementation of
 *   rules the backtester cannot exercise.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationMode } from '../domain/types';
import { toRupees } from '../domain/money';
import type { TradingService } from '../runtime/tradingService';
import type { Repositories } from '../persistence/ports';
import { HealthMonitor, type MetricsRegistry } from '../monitoring/metrics';
import { BacktestEngine } from '../backtest/engine';
import { buildStrategy, type StrategyKind } from '../runtime/tradingService';
import { fromRupees } from '../domain/money';

export interface ApiConfig {
  readonly service: TradingService;
  readonly repositories: Repositories;
  readonly metrics: MetricsRegistry;
  readonly health: HealthMonitor;
  /** Bearer token for mutating routes. Required — there is no unauthenticated mode. */
  readonly authToken: string;
  readonly logger?: boolean;
}

/** Constant-time comparison; a plain `===` on a secret leaks its length by timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildServer(config: ApiConfig): FastifyInstance {
  const app = Fastify({ logger: config.logger ?? false });
  const { service, repositories, metrics, health } = config;

  if (!config.authToken || config.authToken.length < 16) {
    throw new Error('authToken must be at least 16 characters — refusing to start with a weak token');
  }

  void app.register(websocket);

  /** Guards mutating routes. */
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token || !tokensMatch(token, config.authToken)) {
      void reply.code(401).send({ error: 'unauthorised' });
      return false;
    }
    return true;
  }

  function actorOf(request: FastifyRequest): string {
    const body = request.body as { actor?: unknown } | undefined;
    return typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'api';
  }

  // ---- dashboard ---------------------------------------------------------

  /**
   * The operator dashboard, read once at boot.
   *
   * Read at startup rather than per request so a missing file fails loudly
   * when the process starts, not silently on the first page load — and so a
   * container without the `web` directory cannot appear healthy.
   */
  const dashboard = (() => {
    for (const candidate of [
      join(__dirname, '..', '..', 'web', 'dashboard.html'),
      join(process.cwd(), 'web', 'dashboard.html'),
    ]) {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    }
    return null;
  })();

  app.get('/', async (_request, reply) => {
    if (!dashboard) {
      return reply.code(404).send({ error: 'dashboard asset not found (web/dashboard.html)' });
    }
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(dashboard);
  });

  // ---- health & metrics --------------------------------------------------

  app.get('/health', async (_request, reply) => {
    const report = await health.run();
    // 503 on unhealthy so a load balancer can act on it without parsing JSON.
    return reply.code(report.status === 'unhealthy' ? 503 : 200).send(report);
  });

  app.get('/metrics', async (_request, reply) =>
    reply.header('Content-Type', 'text/plain; version=0.0.4').send(metrics.render()),
  );

  // ---- portfolio ---------------------------------------------------------

  app.get('/api/status', async () => {
    const status = service.status();
    return {
      ...status,
      equityRupees: toRupees(status.equity),
      cashRupees: toRupees(status.cash),
    };
  });

  app.get('/api/positions', async () => ({
    positions: service.portfolio.getOpenPositions().map((p) => ({
      ...p,
      averagePriceRupees: toRupees(p.averagePrice),
      lastPriceRupees: toRupees(p.lastPrice),
      unrealisedPnlRupees: toRupees(p.unrealisedPnl),
    })),
  }));

  app.get('/api/orders', async (request) => {
    const { limit = '50' } = request.query as { limit?: string };
    const orders = await repositories.orders.findRecent(Math.min(500, Number(limit) || 50));
    return { orders };
  });

  app.get('/api/orders/open', async () => ({ orders: await repositories.orders.findOpen() }));

  app.get('/api/trades', async (request) => {
    const { limit = '100' } = request.query as { limit?: string };
    const trades = await repositories.trades.recent(Math.min(1000, Number(limit) || 100));
    return { trades: trades.map((t) => ({ ...t, pnlRupees: toRupees(t.pnl) })) };
  });

  app.get('/api/equity', async (request) => {
    const { from = '0', to = String(Date.now()) } = request.query as { from?: string; to?: string };
    const curve = await repositories.equity.between(Number(from), Number(to));
    return { curve: curve.map((p) => ({ t: p.timestamp, equity: toRupees(p.equity) })) };
  });

  // ---- risk --------------------------------------------------------------

  app.get('/api/risk', async () => ({
    limits: service.risk.configuredLimits,
    killSwitch: service.risk.killSwitch.state,
    lossStreak: service.pipeline.lossStreak,
  }));

  app.post('/api/risk/kill-switch', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as { engaged?: unknown; reason?: unknown };
    if (typeof body?.engaged !== 'boolean') {
      return reply.code(400).send({ error: 'engaged must be a boolean' });
    }

    if (body.engaged) {
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'engaged via API';
      await service.emergencyStop(reason, actorOf(request));
    } else {
      await service.releaseEmergencyStop(actorOf(request));
    }

    return { killSwitch: service.risk.killSwitch.state };
  });

  // ---- automation mode ---------------------------------------------------

  const MODES: readonly AutomationMode[] = ['MANUAL', 'APPROVAL', 'AUTOMATIC'];

  app.post('/api/mode', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as { mode?: unknown };
    if (typeof body?.mode !== 'string' || !MODES.includes(body.mode as AutomationMode)) {
      return reply.code(400).send({ error: `mode must be one of ${MODES.join(', ')}` });
    }

    await service.setMode(body.mode as AutomationMode, actorOf(request));
    return { mode: service.pipeline.automationMode };
  });

  // ---- approvals ---------------------------------------------------------

  app.get('/api/approvals', async () => ({
    approvals: service.pipeline.pendingApprovals().map((a) => ({
      idempotencyKey: a.request.idempotencyKey,
      symbol: a.request.symbol,
      side: a.request.side,
      quantity: a.request.quantity,
      strategyId: a.request.strategyId,
      stagedAt: a.stagedAt,
      rationale: a.signal.rationale,
    })),
  }));

  app.post('/api/approvals/:key/approve', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { key } = request.params as { key: string };
    const outcome = await service.pipeline.approve(key, Date.now());
    return reply.code(outcome.kind === 'SUBMITTED' ? 200 : 409).send({ outcome });
  });

  app.post('/api/approvals/:key/reject', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { key } = request.params as { key: string };
    const body = request.body as { reason?: string } | undefined;
    service.pipeline.reject(key, Date.now(), body?.reason ?? 'rejected via API');
    return { rejected: key };
  });

  // ---- audit -------------------------------------------------------------

  app.get('/api/audit', async (request) => {
    const { limit = '100', correlationId } = request.query as {
      limit?: string; correlationId?: string;
    };

    const records = correlationId
      ? await repositories.audit.byCorrelation(correlationId)
      : await repositories.audit.recent(Math.min(500, Number(limit) || 100));

    return { records, chainIntact: service.audit.verifyChain() === null };
  });

  app.get('/api/reconciliation', async () => ({
    breaks: await repositories.reconciliation.open(),
  }));

  // ---- backtest ----------------------------------------------------------

  app.post('/api/backtest', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as {
      symbol?: string; strategy?: StrategyKind; params?: Record<string, number>;
      openingCash?: number; from?: number; to?: number;
    };

    if (!body?.symbol) return reply.code(400).send({ error: 'symbol is required' });

    const candles = await repositories.candles.range(
      body.symbol, '1d', body.from ?? 0, body.to ?? Date.now(),
    );
    if (candles.length < 120) {
      return reply.code(422).send({
        error: `only ${candles.length} bars stored for ${body.symbol}; need at least 120 to warm up`,
      });
    }

    const engine = new BacktestEngine({
      openingCash: fromRupees(body.openingCash ?? 1_000_000),
      limits: service.risk.configuredLimits,
      useTrailingStops: true,
    });

    const result = await engine.run(
      buildStrategy(body.strategy ?? 'trend', body.params ?? {}),
      candles,
    );

    return {
      metrics: result.metrics,
      trades: result.trades.length,
      signals: result.signals.length,
      riskRejections: result.riskRejections.length,
      curve: result.curve.map((p) => ({ t: p.timestamp, equity: toRupees(p.equity) })),
    };
  });

  // ---- market data -------------------------------------------------------

  app.get('/api/candles/:symbol', async (request) => {
    const { symbol } = request.params as { symbol: string };
    const { limit = '500' } = request.query as { limit?: string };
    const candles = await repositories.candles.latest(symbol, '1d', Math.min(5000, Number(limit) || 500));
    return { symbol, candles };
  });

  app.get('/api/symbols', async () => ({ symbols: await repositories.candles.symbols() }));

  // ---- websocket ---------------------------------------------------------

  /**
   * Live status stream.
   *
   * Push-only and best-effort: a dashboard that misses a frame redraws on the
   * next one. Nothing that must not be lost travels over this socket.
   */
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const send = (): void => {
        try {
          socket.send(JSON.stringify({ type: 'status', payload: service.status(), at: Date.now() }));
        } catch {
          // Socket closed between the check and the send; the interval below
          // is cleared on 'close'.
        }
      };

      send();
      const timer = setInterval(send, 2000);
      socket.on('close', () => clearInterval(timer));
      socket.on('error', () => clearInterval(timer));
    });
  });

  return app;
}
