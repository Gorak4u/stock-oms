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

**The audit log is append-only in the database.** Triggers reject `UPDATE`,
`DELETE` *and* `TRUNCATE` on `audit_record`, so a mistake in application code
cannot rewrite history. `TRUNCATE` needs its own statement-level trigger —
Postgres never fires a row-level one for it — and it was the gap that mattered
most, because it takes the whole chain in a single statement rather than one
record. Records are hash-chained, and the chain **continues across restarts**
rather than forking. Test fixtures that need a clean table lift the guard
explicitly, in a helper named for it, rather than the guard being weakened to
accommodate them.

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
npm run lint
npm test                # 740 tests
npm run build && npm start

npm run backtest -- --csv ./data/daily.csv    # or --symbol NSE:RELIANCE
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

Fill it with real history rather than generated data:

```bash
npm run backfill -- --symbols NSE:RELIANCE,NSE:TCS --interval 1d --days 400
npm start                    # then open http://localhost:8080
```

The backfill needs Kite credentials, because that is where the bars come from.
There is deliberately no synthetic seeder: a database holding generated bars
next to real ones cannot be told apart afterwards, and every figure computed
from it — P&L, drawdown, the risk engine's own baselines — is fiction that
looks exactly like measurement.

To exercise the pipeline without a broker account, backtest a CSV export
instead. That runs the same signal → risk → sizing → OMS → fill → portfolio
path, against data you can vouch for:

```bash
npm run backtest -- --csv ./data/reliance-daily.csv
```

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

### The live feed, and when you need it

Backfill and the periodic sync both read Kite's **historical** endpoint. That
endpoint does not publish a bar until it has closed, and it is rate-limited far
below a quote feed. On daily bars this is invisible. On minute bars it means
every decision is taken against a bar the market has already moved past.

`LIVE_FEED=1` opens Kite's streaming WebSocket, assembles ticks into bars and
writes them as each bucket closes:

```bash
LIVE_FEED=1 BROKER=zerodha BAR_INTERVAL=1m SYMBOLS=NSE:RELIANCE,NSE:TCS npm start
```

The two sources are deliberately not exclusive. The historical sync keeps
running, and because bars are upserted, the exchange's own settled bar later
replaces the one assembled from ticks. That ordering is the point: trade on the
fast copy, keep the accurate one.

Three things it does that a plain socket would not:

- **A watchdog on silence, not just on close.** Kite heartbeats about once a
  second. A connection that stays open and stops delivering is the dangerous
  state — the socket reports healthy while the strategy trades on a stale bar —
  so no frame within `TICKER_HEARTBEAT_MS` forces a reconnect.
- **Ticks are validated before they reach a bar.** A fat-finger print reaches
  the strategy as a genuine signal and the risk engine as a genuine mark, so the
  price-band check sits in front of the aggregator.
- **It follows the leader lock.** Kite caps concurrent ticker connections; a
  demoted process that kept streaming would deny the new leader its data.

`/health` reports `market-feed` unhealthy when the session is open and the feed
is connected but silent — which is the failure that is invisible to anything
only inspecting connection state.

### The trading calendar expires

The exchange publishes its holiday list one year at a time, so the list compiled
into any build goes stale on 1 January. An uncovered year is not a calendar
missing a few days — it is one that says the market is open on Republic Day.

So the calendar tracks which years it actually covers. In an uncovered year every
session reads as closed, `/health` reports `calendar` unhealthy, and a critical
alert fires at startup. Supply the year's circular to clear it:

```bash
NSE_HOLIDAYS="2027-01-26,2027-03-11,2027-08-15"   # replaces the built-in list
```

Refusing to trade costs an opportunity; trading through an unlisted holiday
sends orders into a closed exchange, so the default leans the first way.

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
| `NSE_HOLIDAYS` | 2026 list | Exchange holidays, `YYYY-MM-DD`; **replaces** the built-in list |
| `LIVE_FEED` | `false` | Stream quotes over the Kite WebSocket (see below) |
| `LIVE_FEED_FLUSH_MS` | `5000` | How often assembled bars are written |
| `TICKER_HEARTBEAT_MS` | `10000` | Reconnect after this long with no frame |
| `TICKER_STALE_MS` | `120000` | Connected-but-silent for this long is unhealthy |
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
its database connection goes quiet rather than becoming a second writer. Quiet,
and still running: the lock-holding connection has its own error handler, so a
failover or an administrative disconnect makes the process stand down, report a
critical alert, keep serving reads, and re-contend when the database returns —
rather than exiting mid-tick.

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

**The stop is a sizing input, not a resting order.** "Stop-loss required" means
an entry with no stop is refused, and the stop distance is what sizes the
position — it is *not* an `SL-M` parked at the exchange. Every order this
platform sends is `MARKET`. A position is closed when the strategy says so at a
bar close, when the square-off runs before the session ends, or when an operator
closes it from the dashboard; nothing at the broker protects it in between. If
the process is down, or the market gaps through the level between two bars, the
stop does not exist. Placing a protective order alongside each entry fill is the
obvious next step and is not built.

**The emergency stop is not an exit.** It blocks orders that open exposure and
deliberately leaves open positions alone — a control that force-liquidated on
engagement would turn a precaution into a market order at the worst moment. To
be flat, close the positions.

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
| `POST /api/positions/:symbol/flatten` | Close one position at market, now |
| `GET /api/audit` | Audit records and chain verification |
| `GET /api/reconciliation` | Open breaks against the broker |
| `GET /api/broker/session` | Whether a login is needed, and the login URL |
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

## Operating it

Everything an operator does day to day is on the dashboard at `/`; the API
routes below are what it calls, not a second interface you are expected to use
by hand.

| Task | Where |
| --- | --- |
| See what the strategy wants to do, and why | **Pending approvals** — symbol, side, quantity, the signal's own rationale, and how long ago it was staged |
| Let orders through | **Controls** — Manual, Approval, Automatic |
| Send a staged order | **Approve** — risk is re-run first, and a refusal says which control refused it |
| Close a position now | **Close**, on the position's row |
| Halt new risk | **Emergency stop** — blocks orders that open exposure, leaves positions open |
| See why nothing is trading | **System** — database, broker, audit chain, leadership, calendar, market data |
| The daily Kite login | **Broker session** — follow the login link, paste the `request_token` |

The **System** panel is the one worth knowing about before you need it. A quiet
loop looks identical whether the market is closed, the calendar has expired, the
data has gone stale, the broker session needs its daily login, or this instance
is a follower — and the position book shows exactly the same thing in all five
cases.

Signals reach the dashboard only when the loop is actually running: the session
is open, this process holds the leader lock, the `candle` table has bars at the
configured `BAR_INTERVAL`, and a market data provider is configured. On
`BROKER=paper` there is no provider, and the log says so at startup.

### Closing a position by hand

The **Close** button is the only exit an operator can start. It sends a market
order for the whole position immediately and is not staged for approval even in
`APPROVAL` mode — staging exists so a human reviews an order the *system*
proposed, and an order the human just asked for has already had that review.

It is refused, with the reason, when there is no position, when an order is
already working on that symbol (two clicks are two intents and would place two
orders), and on any instance that does not hold the trading lock. Every use is
written to the audit log as `MANUAL_EXIT` with the actor, before the order is
sent.

### Approvals accumulate

A staged approval is kept until it is approved or rejected, and a new signal on
the same symbol stages another rather than replacing it. Over a long unattended
run the queue grows without bound, and because risk is re-run at approval time,
old entries are refused anyway — usually with `MARKET_CLOSED` or a stale-data
rejection. The dashboard sorts newest first, shows each entry's age, and renders
the 50 most recent, so the actionable ones stay at the top. Expiring them
outright is a policy decision that has not been made.

## Backtest console

Served at **`/console`** by the running platform — the same application, not a
separate one. `npm run build` produces it as part of the normal build.

It runs the **real engine** compiled to the browser — same strategy, risk,
sizing, cost and fill code as the Node build, so results match `npm run backtest`
exactly. It takes your own OHLC CSV — the only input it accepts — and surfaces
which risk control refused each signal. Because it computes entirely client-side and
reaches nothing, it is also the one page that can be published on its own
(`npm run build:static`) without exposing the engine.

`node:crypto` is aliased to a pure-JS SHA-256 for that bundle; the test suite
asserts the two agree byte for byte, including at the padding boundaries.

## Testing

740 tests. The parts worth calling out:

- **One contract suite, two implementations.** The in-memory and Postgres
  repositories run the same 45 cases, so a divergence fails the build. It has
  already caught one.
- **Live infrastructure.** The persistence, API, migration and leader-election
  suites run against real Postgres; the queue and alert-delivery suites against
  real Redis. They skip loudly, never silently — and under `REQUIRE_INFRA=1`,
  which CI sets, they fail instead of skipping.
- **Numerical checks.** Options greeks are pinned against numerical derivatives
  and put-call parity; the crypto shim against published SHA-256 vectors.
- **The wire format, not the wrapper.** The Kite ticker's binary frames are
  built byte by byte in the tests — quote, full, LTP and index packets, a
  truncated frame, a heartbeat — so the parser is checked against the layout
  rather than against its own assumptions. The connection tests drive
  reconnection, re-subscription and the silent-socket watchdog through a fake
  socket, with no network involved.
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

Three more found by driving the built artefacts end to end against a local
Postgres, all of which every existing test passed straight through:

- **The rate limiter was applied to nothing.** `register()` defers a plugin
  until boot, so routes declared synchronously afterwards were built before the
  limiter's hook existed. Every route answered uncapped, with no
  `x-ratelimit-*` headers, while the configuration said 300 a minute. Nothing
  errored, which is why nothing noticed.
- **Losing the database killed the process.** The advisory lock is held by a
  connection checked out of the pool and never returned, so `pool.on('error')`
  — which fires only for clients idle *in* the pool — never saw its failures. A
  failover, an admin `pg_terminate_backend` or a maintenance restart emitted an
  unhandled `'error'` and took the trading loop down mid-tick, skipping the
  drain that exists to avoid exiting between "order persisted" and "broker
  acknowledged". It now stands down and re-contends, which is what the
  single-writer section already claimed it did.
- **`TRUNCATE` walked through the append-only guarantee.** Covered above.

A fourth was a health message rather than a defect: a follower reported
"another instance is trading" whether or not there was one, so a database
outage — in which *nobody* is trading — read as a healthy rolling deploy.

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
- [x] Operator dashboard — every day-to-day action, including the manual exit,
      the daily broker login and a health panel that says why the loop is quiet
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
What is missing is real market history, and nothing in this repository will
manufacture a stand-in for it: a generated series has none of the structure a
strategy exists to exploit, so a metric measured on one is not a weak result but
an absence of one.

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
