# AI Trading Platform

A resilient, auditable, single-user automated NSE trading platform.

> **Status: complete stack, unproven strategies.** Every layer in the
> architecture is built, tested and runs — market data ingestion, API,
> persistence, messaging, monitoring, containers, the live trading loop, and the
> operator dashboard. The operational machinery a live deployment needs is
> there too: versioned migrations, leader election, a drained shutdown, broker
> session refresh without a restart, and CI that exercises all of it against
> real Postgres and Redis.
>
> What is *not* done is the part no amount of code can supply: the acceptance
> criteria at the bottom of this file are unmet, because none of them can be met
> without real NSE market data and time. **The system being production-grade and
> the strategies being worth running are different claims, and only the first is
> supported.** A well-built machine for executing an unvalidated edge will
> execute it faithfully all the way down.
>
> **Do not point this at a funded broker account.** It defaults to a paper
> broker, and reaching a live one takes a deliberate configuration change. That
> default is the last line of defence, not a limitation to work around.

---

## Design commitments

These are enforced by tests, not merely intended. Where a commitment cost
something, the cost is stated.

**Money is integer paise.** No monetary value is ever a float, in the
application or in the database. `0.1 + 0.2` is a curiosity in a spreadsheet
and a reconciliation break in an execution path.

**No lookahead.** Indicators return arrays aligned to their input with `null`
through the warm-up; strategies may only read up to the current index; the
backtester decides on a bar's close and fills on the next bar's open. A test
runs the same prefix inside two series with *different futures* and asserts
identical equity curves — if a strategy could see ahead, they would diverge.

**Determinism.** Same inputs, same outputs. Strategies do no I/O and consult no
clock; model training is full-batch with a fixed iteration count and no
randomness; a backtest run twice is byte-identical.

**One intent, one order.** Idempotency keys are derived from the trade intent,
not generated, so a retry after a crash re-derives the same key. The key is
`UNIQUE` in Postgres, so duplicate prevention survives a process restart rather
than living only in memory.

**Uncertain is not the same as failed.** A broker timeout or 5xx on a *submit*
is classified `UNCERTAIN`, never retryable — the order may have reached the
exchange. The OMS parks it and reconciles against the broker's own order book.
The same failure on a read is merely retryable. Conflating the two is how
automated systems end up with two positions where the operator intended one.

**Risk-reducing orders are never blocked.** Every risk control can stop an order
that opens exposure; none may stop one that closes it. A control that traps the
account in a losing position is worse than no control.

**Circuit breakers pause, they do not latch.** The consecutive-loss breaker
releases after a cooling-off period. An earlier revision latched, and because
only a *winning* trade clears a losing streak while no trade could be opened, it
disabled the system permanently the first time it tripped — silently, while
every dashboard showed it running.

**Costs always apply.** Brokerage, STT, exchange charges, GST, SEBI fees, stamp
duty and slippage are charged in every backtest. On NSE intraday a round trip
costs roughly 0.05–0.12% of turnover; a strategy with a 0.08% gross edge is a
losing strategy, and only a cost model reveals that.

**The model can only veto.** The AI layer filters signals the strategy layer
already produced — it cannot originate a trade, pick a direction, or enlarge a
position. It also fails *open*: no promoted model, a thrown exception, missing
features or detected drift all pass the signal through untouched.

**The audit log is append-only in the database.** A trigger rejects `UPDATE` and
`DELETE` on `audit_record`, so a mistake in application code cannot rewrite
history. Records are hash-chained, and the chain **continues across restarts**
rather than forking.

**State survives restarts, including the emergency stop.** The portfolio is
rebuilt by replaying stored fills, never by trusting a stored position row — so
a stale or corrupted position cannot outlive a restart. Automation mode and an
engaged kill switch are both restored: a crash must not silently resume trading
a human had stopped.

## Layout

```
src/
  domain/        integer-paise money, core types
  marketdata/    NSE calendar, tick→OHLC, validation, corporate actions
  features/      technical indicators
  ai/            feature extraction, logistic baseline, PSI drift, registry,
                 inference gating, training pipeline
  strategy/      trend following, mean reversion, momentum, volatility breakout
  options/       Black-Scholes pricing, greeks, defined-risk structures
  risk/          stop-distance sizing, the control set, kill switch
  execution/     costs, broker interface, paper broker, Zerodha connector,
                 portfolio, OMS
  backtest/      engine, metrics, walk-forward validation
  pipeline/      the workflow spine (manual / approval / automatic)
  marketdata/    NSE calendar, tick→OHLC, validation, corporate actions,
                 Kite and CSV history providers, the ingestion service
  persistence/   versioned migrations, repository ports, Postgres and
                 in-memory adapters, leader election
  messaging/     Redis queue with retries, dead-letter and crash recovery
  monitoring/    metrics, health, alerts, durable alert delivery,
                 trade reconciliation
  runtime/       trading service, live runner
  api/           Fastify REST + WebSocket
  main.ts        process entrypoint
web/             operator dashboard, backtest console template
```

## Running it

### Full stack

```bash
export API_TOKEN=$(openssl rand -hex 24)   # required; ≥16 chars
docker compose up --build
```

Then open **http://localhost:8080** for the operator dashboard.

### Deploying

One application, one deploy, serving the dashboard at `/`, the backtest console
at `/console`, and the API at `/api/*`. Two ways to run it:

- **An always-on process** — Fly.io, Render, Railway, a VPS. Schedules its own
  loop, holds a Postgres advisory lock, streams over a websocket. The stronger
  foundation. `fly.toml`, `render.yaml` and `docker-compose.yml` are in the repo.
- **Vercel** — one deploy, with the tick driven by Vercel Cron and the
  single-writer guard expressed as a lease. Simpler to operate, with real
  constraints: cron delivery is best-effort, and the in-memory paper broker
  cannot fill, so live trading needs `BROKER=zerodha`. `vercel.json` is wired up.

This works only because the pipeline's risk state and the square-off guard are
persisted rather than held in memory — which was also a live bug in the
always-on deployment, where a restart reset the drawdown baseline.

See **[DEPLOYMENT.md](DEPLOYMENT.md)**.

### Locally

```bash
npm install
npm run typecheck
npm test                # 638 tests
npm run build && npm start

npm run backtest        # terminal demo over a synthetic series
npm run build:console   # dist/console.html — interactive, open in a browser
```

Requires Node 20+, Postgres 16 and Redis. The tests skip the Postgres and Redis
suites (loudly) when neither is reachable, so the deterministic core stays
testable on a bare machine. CI sets `REQUIRE_INFRA=1`, which turns those skips
into failures — a green build that silently ran neither adapter suite is worse
than a red one.

### Trying it end to end

A fresh install has an empty `candle` table, which means an empty dashboard and
a loop with nothing to decide on. That is correct and completely uninformative —
you cannot tell a working system from a broken one when both show zero.

```bash
npm run seed -- --reset      # synthetic data, ~400 trading days, 3 symbols
npm start                    # then open http://localhost:8080
```

The seed does not insert rows into `order` and `trade`. It drives the real
pipeline — signal → risk → sizing → OMS → paper broker → fill → portfolio →
persistence → audit — one bar at a time, so what you end up looking at was
produced by the code that would run against a live broker. It leaves the system
in `MANUAL`, and refuses to run against a database that already holds candles
unless you pass `--reset`.

The data is synthetic. It demonstrates that the pipeline carries a decision from
bar to fill to ledger; it says nothing about whether any strategy makes money.

### Loading market data

Nothing decides anything until the `candle` table has bars in it. The live loop
reads from it, the backtester reads from it, and an empty table means a process
that ticks quietly forever without placing a trade.

```bash
# From CSV files — how five years of history usually arrives
npm run backfill -- --source csv --interval 1d \
  --file NSE:RELIANCE=./data/reliance.csv \
  --file NSE:TCS=./data/tcs.csv

# From the broker (needs a live Kite session; capped by Kite's own limits)
npm run backfill -- --source kite --symbols NSE:RELIANCE,NSE:TCS \
  --interval 1d --from 2019-01-01
```

CSV columns are matched case-insensitively (`date,open,high,low,close,volume`);
dates may be `YYYY-MM-DD`, `DD-MM-YYYY`, ISO, or epoch. A bare date is read as
the IST session open, not UTC midnight — the latter lands on the previous
trading day and would shift every bar in the file by a session.

Re-running is safe: bars are upserted by `(symbol, interval, timestamp)`, so a
corrected file overwrites what it should and changes nothing else. Once running
with `BROKER=zerodha`, the process keeps the recent window current on its own.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_TOKEN` | — | **Required.** Bearer token for every route; ≥16 chars |
| `DATABASE_URL` | local Postgres | Connection string |
| `REDIS_URL` | unset | Enables the Redis health check and durable alerts |
| `BROKER` | `paper` | `paper` or `zerodha` |
| `KITE_API_KEY` / `KITE_ACCESS_TOKEN` | — | Required when `BROKER=zerodha` |
| `KITE_API_SECRET` | — | Lets `/api/broker/session` exchange a `request_token` |
| `OPENING_CASH` | `1000000` | Opening capital, in rupees |
| `STRATEGY` | `trend` | `trend`, `meanReversion`, `momentum`, `volatility` |
| `SYMBOLS` | empty | Comma-separated watchlist |
| `BAR_INTERVAL` | `1m` | Bar size the loop trades on |
| `MARKET_DATA_SYNC_MS` | `60000` | How often to pull fresh bars |
| `MARKET_DATA_MAX_AGE_MS` | `900000` | Data older than this is unhealthy mid-session |
| `API_PUBLIC_READS` | `false` | Serve reads without a token (see below) |
| `CORS_ORIGINS` | empty | Browser origins allowed to call the API |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-client request cap |
| `ALERT_WEBHOOK_URL` | unset | Enables durable alert delivery via Redis |
| `SHUTDOWN_DRAIN_MS` | `30000` | How long SIGTERM waits for a tick in flight |
| `PGSSLMODE` | unset | `require`, `verify-full`, … for TLS to Postgres |
| `PGPOOL_MAX` / `PG_STATEMENT_TIMEOUT_MS` | `10` / `15000` | Pool sizing and query timeout |
| `RISK_PER_TRADE` / `MAX_POSITION` / `DAILY_LOSS_LIMIT` / `MAX_DRAWDOWN` | see below | Risk limits as fractions |

### Access control

**Every route requires the bearer token**, reads included. Reads change nothing,
but they disclose the entire position book, the equity curve and the audit log —
enough to trade against the account holder. `/health` and `/metrics` are the
exceptions, because the container healthcheck and the metrics scraper have no
token and neither discloses account data.

`API_PUBLIC_READS=true` opens the read routes deliberately, for a dashboard
behind a proxy that authenticates. Writes stay guarded regardless.

The WebSocket authenticates too, via `?token=` — browsers cannot set headers on
a handshake. That is the only place a token is accepted in a URL.

### Running more than one instance

A Postgres advisory lock elects a single leader. Followers serve the API, health
and metrics, but never decide, ingest or reconcile — two processes acting on one
account place two orders for one intent, and per-instance idempotency keys do
not prevent it, because each derives its own key from its own decision.

Leadership is checked every tick, not once at startup, so a leader that loses
its database connection goes quiet rather than becoming a second writer.

### Schema changes

Migrations live in `src/persistence/migrations`, named `NNN_description.sql`,
and are applied in order at startup: one transaction each, serialised by an
advisory lock, and checksummed so editing an already-applied migration is
refused rather than silently diverging from production. Add a new file; never
edit an applied one.

## The workflow

```
market data → features → strategy → AI → risk → execution → broker
```

`TradingPipeline` sequences those layers and holds no trading logic itself.
`BacktestEngine` drives the *same* components against history — anything
simulated in one and reimplemented in the other is a place the two can silently
disagree, so the only simulated pieces are the clock and the exchange.

### Automation modes

| Mode | Behaviour |
| --- | --- |
| `MANUAL` | Signals recorded, orders staged, nothing sent |
| `APPROVAL` | Orders staged; risk is **re-checked at approval time**, since a verdict from minutes ago may have been overtaken by a drawdown |
| `AUTOMATIC` | Orders sent as soon as they clear risk |

Mode changes are audited with the actor — "who turned automatic trading on, and
when" is the first question asked after an incident.

## Risk controls

| Control | Default | Behaviour |
| --- | --- | --- |
| Risk per trade | 1% of equity | Sizes the position from the stop distance |
| Max position value | 10% of equity | Scales down |
| Gross / net exposure | 100% / 75% | Scales down |
| Symbol concentration | 15% | Scales down |
| Daily loss limit | 3% of start-of-day equity | Halts |
| Max drawdown | 15% from peak | Halts |
| Max open positions | 10 | Halts |
| Consecutive losses | 4, then a cooling-off period | Pauses |
| Order rate | 30/minute | Halts (runaway-loop guard) |
| Stop-loss required | on | Rejects entries with no protective stop |
| Emergency stop | manual | Blocks all risk-increasing orders; survives restarts |

State controls reject; size controls scale the quantity down. Trading less is a
sensible response to "this order is too big", but not to "the system should not
be trading at all".

## API

Every route needs `Authorization: Bearer $API_TOKEN` except `/health` and
`/metrics`. See [Access control](#access-control).

| Route | Purpose |
| --- | --- |
| `GET /` | Operator dashboard. **Open** (a shell; its data is not) |
| `GET /console` | Backtest console. **Open** (computes client-side, reaches nothing) |
| `GET /health` | Health report; 503 when unhealthy. **Open** |
| `GET /metrics` | Prometheus exposition. **Open** |
| `GET /api/status` | Mode, equity, kill switch, loss streak |
| `GET /api/positions` · `/api/orders` · `/api/trades` · `/api/equity` | Portfolio |
| `GET /api/risk` | Configured limits and current state |
| `POST /api/mode` | Change automation mode |
| `POST /api/risk/kill-switch` | Engage or release the emergency stop |
| `GET /api/approvals` · `POST /api/approvals/:key/{approve,reject}` | Approval queue |
| `GET /api/audit` | Audit records and chain verification |
| `GET /api/reconciliation` | Open breaks against the broker |
| `POST /api/broker/session` | Supply the day's Kite `requestToken` or `accessToken` |
| `POST /api/backtest` | Backtest a stored symbol |
| `WS /ws?token=…` | Live status stream (best-effort) |

### The daily Kite login

Kite access tokens expire around 07:30 IST and there is no refresh token — a
human must visit the login URL and hand back the `request_token`. The platform
persists the token, predicts the expiry from the clock, detects a rejected one
from `TokenException`, and raises a **critical** alert naming the login URL.

Supplying the new token takes no restart:

```bash
curl -X POST localhost:8080/api/broker/session \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"requestToken":"...from the login redirect...","actor":"alice"}'
```

With no valid token the process still starts and serves the API — that is the
only way an operator can supply one. It reports `broker-session` as unhealthy
until they do.

## Backtest console

Served at **`/console`** by the running platform — the same application, not a
separate one. `npm run build` produces it as part of the normal build.

It runs the **real engine** compiled to the browser — same strategy, risk,
sizing, cost and fill code as the Node build, so results match `npm run backtest`
exactly. It takes synthetic data or your own OHLC CSV, and surfaces which risk
control refused each signal. Because it computes entirely client-side and
reaches nothing, it is also the one page that can be published on its own
(`npm run build:static`) without exposing the engine.

`node:crypto` is aliased to a pure-JS SHA-256 for that bundle; the test suite
asserts the two agree byte for byte, including at the padding boundaries.

## Testing

638 tests. The parts worth calling out:

- **One contract suite, two implementations.** The in-memory and Postgres
  repositories run the same 45 cases, so a divergence fails the build. It has
  already caught one.
- **Live infrastructure.** The persistence, API, migration and leader-election
  suites run against real Postgres; the queue and alert-delivery suites against
  real Redis. They skip loudly, never silently — and under `REQUIRE_INFRA=1`,
  which CI sets, they fail instead of skipping.
- **Numerical checks.** Options greeks are pinned against numerical derivatives
  and put-call parity; the crypto shim against published SHA-256 vectors.
- **An end-to-end smoke test in CI.** It boots the real `main.js` against a real
  database, asserts the health report, that a read without a token is refused,
  and that SIGTERM drains rather than truncates. Unit tests cover every layer
  and none of them would notice the entrypoint failing to wire them together.

Jest runs serially (`maxWorkers: 1`) because the database-backed suites share
one database and truncate between cases.

Three bugs found by tests written during the production-readiness pass, kept as
regressions: an empty CSV price cell parsing as ₹0 rather than being skipped;
`CREATE TABLE IF NOT EXISTS` racing under concurrent migration appliers; and an
advisory-lock key above 2³¹ splitting across `classid`/`objid` in `pg_locks`, so
the leader's own heartbeat concluded it had lost a lock it still held — and
stood down, producing the two leaders the lock exists to prevent.

## Roadmap

Built and tested:

- [x] Market data — NSE calendar, tick→OHLC, validation, corporate actions
- [x] Market data ingestion — Kite historical and CSV providers, backfill CLI,
      watermarked incremental sync, staleness health check
- [x] Feature engineering and the AI layer, including the training pipeline
- [x] Four strategies, plus options pricing and five defined-risk structures
- [x] Risk engine, position sizing, kill switch
- [x] Execution — costs, paper broker, Zerodha connector, portfolio, OMS
- [x] Broker session lifecycle — persisted token, login-flow exchange, expiry
      detection, refresh without a restart
- [x] Backtesting — engine, metrics, walk-forward validation
- [x] Persistence — versioned transactional migrations, repositories, pool
      timeouts and TLS, leader election
- [x] Messaging — Redis queue with retries, dead-letter, crash recovery, wired
      to durable alert delivery
- [x] Monitoring — metrics, health checks, alerting, trade reconciliation
- [x] API — REST, WebSocket, token auth on every route, rate limiting, CORS
- [x] Operator dashboard
- [x] Live trading runner with session awareness, square-off and a drained
      shutdown
- [x] Containers — Dockerfile and docker-compose
- [x] CI — typecheck, tests against real Postgres and Redis, build, image, and
      an end-to-end smoke test

Deliberately not built:

- [ ] Multi-user accounts and roles — the platform is single-user by design
- [ ] GraphQL — REST plus a WebSocket covers every current consumer
- [ ] A separate feature-store service — the extractor is in-process and fast enough
- [ ] Naked short options — unbounded loss cannot be sized against

## Acceptance criteria

**None of these are met, and that is the honest position:**

- [ ] Five years of backtesting on real NSE data
- [ ] Walk-forward validation on that data
- [ ] Paper trading
- [ ] Live testing with small capital
- [ ] Continuous monitoring

The engine, the metrics and the walk-forward machinery are ready and tested.
What is missing is real market history. Synthetic data can only demonstrate
that the machinery runs — on a random walk the strategies return roughly zero
and walk-forward efficiency correctly reports the in-sample results as fitted
noise. That is the system working, not a result.

**The next step is data, not code** — and there is now a supported way to load
it. `npm run backfill` fills the `candle` table from a CSV dump or from the
broker; see [Loading market data](#loading-market-data). What no amount of
tooling supplies is the data itself, or the months of walk-forward and paper
trading that have to follow before any of these strategies has earned real
capital.

Work through the list in order. Each item exists to fail cheaply: a strategy
that dies in walk-forward costs nothing, and the same strategy discovered in
live trading costs whatever it was sized to.

## Purpose

The purpose of the system is not to avoid losses completely. It is to achieve
positive long-term expectancy while protecting capital.
