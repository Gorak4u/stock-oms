/**
 * HTTP API.
 *
 * Fastify over the trading service. Three rules shape the route design:
 *
 * - **Everything is authenticated by default.** Reads were once open, on the
 *   reasoning that they change nothing. But what they *disclose* is the entire
 *   position book, the equity curve and the audit log — enough to trade against
 *   the account holder, and enough to be worth stealing on its own. Reads can
 *   be opened deliberately (`publicReads`) for a dashboard behind a trusted
 *   proxy; they are no longer open by accident.
 * - **Dangerous actions name their actor.** Engaging the kill switch or
 *   switching to automatic trading records who did it, so the audit log can
 *   answer "who turned this on" months later.
 * - **The API never contains trading logic.** It validates, delegates to the
 *   service, and serialises. Anything else would be a second implementation of
 *   rules the backtester cannot exercise.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationMode } from '../domain/types';
import { toRupees } from '../domain/money';
import type { TradingService } from '../runtime/tradingService';
import type { Repositories } from '../persistence/ports';
import type { PipelineOutcome } from '../pipeline/tradingPipeline';
import { HealthMonitor, type MetricsRegistry } from '../monitoring/metrics';
import { BacktestEngine } from '../backtest/engine';
import { buildStrategy, type StrategyKind } from '../runtime/tradingService';
import { fromRupees } from '../domain/money';

export interface ApiConfig {
  readonly service: TradingService;
  readonly repositories: Repositories;
  readonly metrics: MetricsRegistry;
  readonly health: HealthMonitor;
  /** Bearer token for every route. Required — there is no unauthenticated mode. */
  readonly authToken: string;
  readonly logger?: boolean;
  /**
   * Serve read routes without a token.
   *
   * Off by default. Only turn it on where something else is doing the
   * authenticating — a reverse proxy, an SSO gateway — because it publishes
   * positions, trades and the audit log to anyone who can reach the port.
   */
  readonly publicReads?: boolean;
  /** Origins allowed to call the API from a browser. Empty disables CORS entirely. */
  readonly corsOrigins?: readonly string[];
  /** Requests per minute per client. Protects the database behind the read routes. */
  readonly rateLimitPerMinute?: number;
  /** Largest accepted request body. Backtest payloads are the biggest legitimate one. */
  readonly bodyLimitBytes?: number;
  /**
   * Current broker session state, for the dashboard to render.
   *
   * The Kite token expires around 07:30 IST daily and cannot be refreshed
   * without a human visiting the login URL, so an operator needs to see whether
   * one is needed and follow the link — not read it out of a critical alert in
   * the container's log stream.
   */
  readonly brokerSession?: () => {
    loginUrl: string; expiresAt: number | null; valid: boolean;
  };
  /** Called when an operator supplies a fresh broker session token. */
  readonly onBrokerSession?: (input: {
    requestToken?: string; accessToken?: string; actor: string;
  }) => Promise<{ expiresAt: number | null }>;
  /**
   * Runs one iteration of the trading loop.
   *
   * Present when an external scheduler drives the loop instead of the process
   * scheduling it itself — a serverless deployment, where there is no
   * `setInterval` to own it. Absent on the always-on process, where the runner
   * owns its own timer and an HTTP-triggered tick would race it.
   */
  readonly onTick?: () => Promise<unknown>;
  /**
   * Shared secret the scheduler presents, in addition to the API token.
   *
   * Vercel signs cron requests with `CRON_SECRET`; accepting the API token too
   * lets an operator force a tick by hand while debugging.
   */
  readonly cronSecret?: string;
  /**
   * Gate on whether this process may act on the account.
   *
   * Runs `fn` only when this instance is the one allowed to place orders, and
   * resolves to `null` when it is not. Reads and state changes are safe on any
   * instance; sending an order is not — two processes acting on one account
   * place two orders for one intent, and the idempotency key does not save you,
   * because each derives its own key from its own decision.
   *
   * The two deployments express that guarantee differently, which is why this
   * is a function rather than a boolean: the always-on process holds a Postgres
   * advisory lock for its lifetime, while a serverless invocation takes a job
   * lease for the duration of the work. Both fit behind this.
   *
   * Optional: absent, the action runs unguarded — right for a test or a
   * single-instance run, wrong for anything else.
   */
  readonly withTradingGuard?: <T>(fn: () => Promise<T>) => Promise<T | null>;
}

/** Constant-time comparison; a plain `===` on a secret leaks its length by timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Builds the HTTP application.
 *
 * Asynchronous because the rate limiter has to be *loaded* before any route is
 * declared, not merely queued. `register()` defers a plugin to boot, so routes
 * added synchronously after a bare `register(rateLimit)` were declared before
 * the plugin's `onRequest` hook existed and never picked it up: every route
 * served unthrottled, with no `x-ratelimit-*` headers, while the configuration
 * said 300/minute. Awaiting it loads the plugin first, so the hook is in place
 * when the routes below are declared.
 *
 * The weak-token guard stays synchronous — hence the explicit `Promise` return
 * type rather than `async` — so a misconfigured token still fails at the call
 * rather than on an unhandled rejection somewhere downstream.
 */
export function buildServer(config: ApiConfig): Promise<FastifyInstance> {
  if (!config.authToken || config.authToken.length < 16) {
    throw new Error('authToken must be at least 16 characters — refusing to start with a weak token');
  }
  return assembleServer(config);
}

async function assembleServer(config: ApiConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger ?? false,
    // 1 MiB. A backtest request is a few hundred bytes; anything approaching
    // this is a mistake or an attempt to exhaust memory.
    bodyLimit: config.bodyLimitBytes ?? 1_048_576,
    // Trust the proxy's forwarded address so rate limiting keys on the real
    // client rather than on the single proxy IP every request appears to
    // come from.
    trustProxy: true,
  });
  const { service, repositories, metrics, health } = config;

  await app.register(websocket);

  await app.register(rateLimit, {
    max: config.rateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    // Health and metrics are polled continuously by infrastructure that must
    // never be throttled — a rate-limited health check reads as an outage.
    allowList: (request) => request.url === '/health' || request.url === '/metrics',
  });

  // Default-deny: with no configured origins, no browser origin is allowed and
  // the plugin is not registered at all. Set CORS_ORIGINS when the dashboard is
  // hosted separately from the engine — a CDN in front of a headless API.
  const origins = config.corsOrigins ?? [];
  if (origins.length > 0) {
    await app.register(cors, {
      origin: [...origins],
      methods: ['GET', 'POST', 'OPTIONS'],
      // Explicit rather than reflected: every route authenticates with a bearer
      // token, so a preflight that does not permit Authorization would fail
      // every cross-origin read while looking like a network fault.
      allowedHeaders: ['Authorization', 'Content-Type'],
      // The token travels in a header, not a cookie, so credentialed requests
      // are not needed — and allowing them would widen what a hostile page
      // could do with an existing session.
      credentials: false,
      maxAge: 86_400,
    });
  }

  /**
   * Extracts a bearer token from the header, or from a query parameter.
   *
   * The query fallback exists only for the websocket: browsers cannot set
   * headers on a `WebSocket` handshake, so a token in the URL is the only way
   * to authenticate one. It is accepted nowhere else, because URLs end up in
   * access logs.
   */
  function bearerOf(request: FastifyRequest, allowQuery = false): string {
    const header = request.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) return header.slice(7);

    if (allowQuery) {
      const { token } = request.query as { token?: string };
      if (typeof token === 'string') return token;
    }
    return '';
  }

  function authorised(request: FastifyRequest, allowQuery = false): boolean {
    const token = bearerOf(request, allowQuery);
    return token !== '' && tokensMatch(token, config.authToken);
  }

  /** Guards mutating routes. */
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!authorised(request)) {
      void reply.code(401).send({ error: 'unauthorised' });
      return false;
    }
    return true;
  }

  /**
   * Guards read routes unless reads have been opened deliberately.
   *
   * Applied as a hook rather than per route so a route added later is protected
   * by default — the failure mode of the old per-route approach was that
   * forgetting a guard silently published data.
   */
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    // Unauthenticated by necessity.
    //
    // `/health` and `/metrics`: the container healthcheck and the metrics
    // scraper have no token, and neither discloses account data.
    //
    // `/` and `/console`: a browser cannot set an Authorization header when you
    // navigate to a URL, so a token-guarded page could not be opened at all.
    // Both are empty shells — every figure on the dashboard arrives through the
    // authenticated `/api/*` routes below, and the console computes everything
    // client-side from data you give it. Serving them discloses no more than
    // serving a login form does.
    // `/favicon.ico`: the browser asks for it unprompted on every page load,
    // and a 401 for a request nobody made is noise in the log someone reads
    // when a real authentication problem is being investigated.
    if (
      path === '/health' || path === '/metrics' || path === '/' ||
      path === '/console' || path === '/favicon.ico'
    ) {
      return;
    }

    // Mutating routes and the websocket authenticate themselves, the latter
    // because it also accepts a query token.
    if (request.method !== 'GET' || path === '/ws') return;

    if (config.publicReads) return;

    if (!authorised(request)) {
      await reply.code(401).send({ error: 'unauthorised' });
    }
  });

  function actorOf(request: FastifyRequest): string {
    const body = request.body as { actor?: unknown } | undefined;
    return typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'api';
  }

  // ---- pages -------------------------------------------------------------

  /**
   * Reads a page from the first candidate path that exists.
   *
   * Read at startup rather than per request so a missing file fails loudly when
   * the process starts, not silently on the first page load — and so a
   * container built without its assets cannot appear healthy.
   */
  function loadPage(...candidates: string[]): string | null {
    for (const candidate of candidates) {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    }
    return null;
  }

  const dashboard = loadPage(
    join(__dirname, '..', '..', 'web', 'dashboard.html'),
    join(process.cwd(), 'web', 'dashboard.html'),
  );

  /**
   * The backtest console, served by the same process.
   *
   * It is the same application: one build, one deploy, one URL. The console
   * happens to run its half in the browser — it is the platform core compiled
   * for the browser rather than a separate product — but that is an
   * implementation detail of the page, not a reason to host it somewhere else.
   *
   * Produced by `npm run build`, which runs `build-console.js` into `dist`.
   */
  const backtestConsole = loadPage(
    join(__dirname, '..', 'console.html'),
    join(__dirname, '..', '..', 'dist', 'console.html'),
    join(process.cwd(), 'dist', 'console.html'),
  );

  const html = (reply: FastifyReply, body: string) =>
    reply.header('Content-Type', 'text/html; charset=utf-8').send(body);

  app.get('/', async (_request, reply) => {
    if (!dashboard) {
      return reply.code(404).send({ error: 'dashboard asset not found (web/dashboard.html)' });
    }
    return html(reply, dashboard);
  });

  app.get('/console', async (_request, reply) => {
    if (!backtestConsole) {
      return reply.code(404).send({
        error: 'backtest console not built — run `npm run build`',
      });
    }
    return html(reply, backtestConsole);
  });

  // ---- health & metrics --------------------------------------------------

  /**
   * Answers the browser's automatic favicon request.
   *
   * Without this every dashboard load logs a 401 — the auth hook refusing a
   * request no one made deliberately. That is noise in exactly the log someone
   * reads when investigating a real authentication problem. 204 with no body
   * discloses nothing.
   */
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

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

  /**
   * Closes one position at the market, now, on an operator's say-so.
   *
   * This is the only exit an operator can initiate. Everything else that closes
   * a position is a decision the system made: a strategy emitting FLAT at a bar
   * close, or the square-off ahead of the session end. Neither is available
   * when a human wants out *now* — and the emergency stop is not an exit
   * either, because it blocks orders that open exposure and deliberately leaves
   * open positions alone.
   *
   * Deliberately not staged for approval, even in APPROVAL mode. Staging exists
   * so a human sees an order the system proposed before it goes; an order the
   * human just asked for has already had that review, and queuing it for their
   * own second approval would only add delay to the one action whose whole
   * point is immediacy.
   *
   * It still goes through the OMS rather than around it, so the order is
   * persisted `PENDING_NEW` before the broker call, carries an idempotency key,
   * and reconciles like any other. Risk cannot block it: a pure reduction
   * bypasses the size controls by construction, which is the rule that a
   * control must never trap an account in a losing position.
   */
  app.post('/api/positions/:symbol/flatten', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const { symbol } = request.params as { symbol: string };
    const actor = actorOf(request);

    const act = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      const position = service.portfolio.getPosition(symbol);
      if (!position || position.quantity === 0) {
        return { status: 409, body: { error: `no open position in ${symbol}` } };
      }

      // A second click before the first exit fills would send a second order
      // for the same position: the key is derived from the intent, and an
      // operator clicking twice has produced two intents a millisecond apart.
      // Whether the first one filled is the broker's answer to give, so refuse
      // while anything is still working on this symbol.
      const working = await repositories.orders.findOpen();
      if (working.some((order) => order.request.symbol === symbol)) {
        return {
          status: 409,
          body: { error: `an order is already working on ${symbol} — wait for it to settle` },
        };
      }

      const quantity = Math.abs(position.quantity);
      const side = position.quantity > 0 ? 'SELL' : 'BUY';
      const correlationId = `manual-exit-${symbol}-${Date.now()}`;

      // Recorded before the order is sent, and with the actor: "who flattened
      // this, and when" is asked after an incident, and an audit written only
      // on success would be missing exactly when it is most wanted.
      service.audit.append(
        'MANUAL_EXIT',
        correlationId,
        { symbol, side, quantity, actor },
        Date.now(),
      );

      const order = service.oms.buildRequest(
        { strategyId: 'manual-exit', symbol, side, quantity, decisionBar: Date.now() },
        { orderType: 'MARKET', product: 'MIS', timeInForce: 'DAY' },
      );

      const result = await service.submitExit(order, correlationId);
      if (!result.submitted) {
        return {
          status: 502,
          body: { error: result.refusedReason ?? 'the broker refused the order' },
        };
      }

      return {
        status: 200,
        body: { flattened: symbol, side, quantity, orderId: result.order.id },
      };
    };

    const outcome = config.withTradingGuard ? await config.withTradingGuard(act) : await act();

    // A follower must not place orders. Saying so plainly beats a generic
    // failure: the operator's next move is to open the leader's dashboard, and
    // nothing else in the response would tell them that.
    if (outcome === null) {
      return reply.code(409).send({
        error: 'this instance does not hold the trading lock — use the instance that does',
      });
    }

    return reply.code(outcome.status).send(outcome.body);
  });

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

  /**
   * Puts a refused approval into words.
   *
   * The outcome alone is machine-readable and useless to the person who just
   * clicked Approve: risk is re-run at approval time, so a refusal is normal
   * and the operator's next question is always "why". Returning only the kind
   * left the dashboard showing `HTTP 409` — the one thing they already knew.
   */
  function refusalReason(outcome: PipelineOutcome): string {
    switch (outcome.kind) {
      case 'NO_SIGNAL':
        return 'no such staged order — it may have been approved, rejected or superseded already';
      case 'RISK_REJECTED':
        return `risk refused it on re-check: ${outcome.reasons.join('; ')}`;
      case 'SIZED_TO_ZERO':
        return `sized to zero on re-check: ${outcome.reason}`;
      case 'MODEL_VETOED':
        return `the model vetoed it: ${outcome.reason}`;
      case 'SUBMIT_REFUSED':
        return `the broker refused it: ${outcome.reason}`;
      default:
        return `not submitted (${outcome.kind})`;
    }
  }

  app.post('/api/approvals/:key/approve', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { key } = request.params as { key: string };
    const outcome = await service.pipeline.approve(key, Date.now());

    if (outcome.kind === 'SUBMITTED') return reply.code(200).send({ outcome });

    // Risk is deliberately re-run at approval time, because a verdict from
    // minutes ago may have been overtaken by a drawdown. A refusal here is an
    // ordinary outcome, not a fault, so it carries the explanation with it.
    return reply.code(409).send({ outcome, error: refusalReason(outcome) });
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

  // ---- scheduled tick ----------------------------------------------------

  /**
   * Runs one iteration of the trading loop.
   *
   * Only mounted when something external drives the loop. It places orders, so
   * it authenticates against the scheduler's secret or the API token — never
   * on the strength of the request merely arriving.
   */
  if (config.onTick) {
    const runTick = config.onTick;

    app.post('/api/tick', async (request, reply) => {
      const token = bearerOf(request);
      const permitted =
        (config.cronSecret !== undefined && token !== '' && tokensMatch(token, config.cronSecret)) ||
        (token !== '' && tokensMatch(token, config.authToken));

      if (!permitted) return reply.code(401).send({ error: 'unauthorised' });

      try {
        return await runTick();
      } catch (error) {
        return reply.code(500).send({
          ran: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // ---- broker session ----------------------------------------------------

  /**
   * Supplies a fresh Kite session after the daily token expiry.
   *
   * Kite has no refresh token: a human must visit the login URL and hand back
   * the `request_token` from the redirect. This route is how that gets in
   * without a redeploy or a restart — the alternative was baking the token
   * into the environment, which meant a container restart every morning.
   */
  app.get('/api/broker/session', async () => {
    if (!config.brokerSession) {
      return { configured: false, loginUrl: null, expiresAt: null, valid: true };
    }
    return { configured: true, ...config.brokerSession() };
  });

  app.post('/api/broker/session', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    if (!config.onBrokerSession) {
      return reply.code(404).send({ error: 'the configured broker has no session to refresh' });
    }

    const body = request.body as { requestToken?: unknown; accessToken?: unknown };
    const requestToken = typeof body?.requestToken === 'string' ? body.requestToken.trim() : '';
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';

    if (!requestToken && !accessToken) {
      return reply.code(400).send({ error: 'requestToken or accessToken is required' });
    }

    try {
      const result = await config.onBrokerSession({
        ...(requestToken ? { requestToken } : {}),
        ...(accessToken ? { accessToken } : {}),
        actor: actorOf(request),
      });
      return { ok: true, expiresAt: result.expiresAt };
    } catch (error) {
      // 502: the failure is the broker rejecting the exchange, not a bad
      // request — the operator should retry the login, not fix their payload.
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

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
  await app.register(async (instance) => {
    instance.get('/ws', {
      websocket: true,
      /**
       * Authenticated at the handshake, so an unauthorised client never gets a
       * socket at all — the upgrade is refused with a plain 401 instead of
       * being completed and then closed.
       *
       * This stream carries live equity and position data, and leaving it open
       * was the widest of the read holes: it needed no polling to watch an
       * account in real time.
       */
      onRequest: (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
        if (config.publicReads || authorised(request, true)) return done();
        void reply.code(401).send({ error: 'unauthorised' });
      },
    }, (socket) => {
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
