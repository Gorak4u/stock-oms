# AI Trading Platform

A resilient, auditable, single-user automated NSE trading platform.

> **Status: complete stack, unproven strategies.** Every layer in the
> architecture is built, tested and runs — API, persistence, messaging,
> monitoring, containers, the live trading loop, and the operator dashboard.
> What is *not* done is the part no amount of code can supply: the acceptance
> criteria at the bottom of this file are unmet, because none of them can be
> met without real NSE market data and time.
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
  persistence/   schema, repository ports, Postgres and in-memory adapters
  messaging/     Redis queue with retries, dead-letter and crash recovery
  monitoring/    metrics, health, alerts, trade reconciliation
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

### Locally

```bash
npm install
npm run typecheck
npm test                # 537 tests
npm run build && npm start

npm run backtest        # terminal demo over a synthetic series
npm run build:console   # dist/console.html — interactive, open in a browser
```

Requires Node 20+, Postgres 16 and Redis. The tests skip the Postgres and Redis
suites (loudly) when neither is reachable, so the deterministic core stays
testable on a bare machine.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_TOKEN` | — | **Required.** Bearer token for mutating routes; ≥16 chars |
| `DATABASE_URL` | local Postgres | Connection string |
| `REDIS_URL` | unset | Enables the Redis health check and queues |
| `BROKER` | `paper` | `paper` or `zerodha` |
| `KITE_API_KEY` / `KITE_ACCESS_TOKEN` | — | Required when `BROKER=zerodha` |
| `OPENING_CASH` | `1000000` | Opening capital, in rupees |
| `STRATEGY` | `trend` | `trend`, `meanReversion`, `momentum`, `volatility` |
| `SYMBOLS` | empty | Comma-separated watchlist |
| `RISK_PER_TRADE` / `MAX_POSITION` / `DAILY_LOSS_LIMIT` / `MAX_DRAWDOWN` | see below | Risk limits as fractions |

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

Reads are open; every mutating route needs `Authorization: Bearer $API_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /` | Operator dashboard |
| `GET /health` | Health report; 503 when unhealthy |
| `GET /metrics` | Prometheus exposition |
| `GET /api/status` | Mode, equity, kill switch, loss streak |
| `GET /api/positions` · `/api/orders` · `/api/trades` · `/api/equity` | Portfolio |
| `GET /api/risk` | Configured limits and current state |
| `POST /api/mode` | Change automation mode |
| `POST /api/risk/kill-switch` | Engage or release the emergency stop |
| `GET /api/approvals` · `POST /api/approvals/:key/{approve,reject}` | Approval queue |
| `GET /api/audit` | Audit records and chain verification |
| `GET /api/reconciliation` | Open breaks against the broker |
| `POST /api/backtest` | Backtest a stored symbol |
| `WS /ws` | Live status stream (best-effort) |

## Backtest console

`npm run build:console` produces a self-contained `dist/console.html` that runs
the **real engine** compiled to the browser — same strategy, risk, sizing, cost
and fill code as the Node build, so results match `npm run backtest` exactly. It
takes synthetic data or your own OHLC CSV, and surfaces which risk control
refused each signal.

`node:crypto` is aliased to a pure-JS SHA-256 for that bundle; the test suite
asserts the two agree byte for byte, including at the padding boundaries.

## Testing

537 tests. The parts worth calling out:

- **One contract suite, two implementations.** The in-memory and Postgres
  repositories run the same 45 cases, so a divergence fails the build. It has
  already caught one.
- **Live infrastructure.** The persistence and API suites run against real
  Postgres; the queue suite against real Redis. They skip loudly, never
  silently, when unavailable.
- **Numerical checks.** Options greeks are pinned against numerical derivatives
  and put-call parity; the crypto shim against published SHA-256 vectors.

Jest runs serially (`maxWorkers: 1`) because the database-backed suites share
one database and truncate between cases.

## Roadmap

Built and tested:

- [x] Market data — NSE calendar, tick→OHLC, validation, corporate actions
- [x] Feature engineering and the AI layer, including the training pipeline
- [x] Four strategies, plus options pricing and five defined-risk structures
- [x] Risk engine, position sizing, kill switch
- [x] Execution — costs, paper broker, Zerodha connector, portfolio, OMS
- [x] Backtesting — engine, metrics, walk-forward validation
- [x] Persistence — Postgres schema, repositories, migrations
- [x] Messaging — Redis queue with retries, dead-letter, crash recovery
- [x] Monitoring — metrics, health checks, alerting, trade reconciliation
- [x] API — REST, WebSocket, token auth
- [x] Operator dashboard
- [x] Live trading runner with session awareness and square-off
- [x] Containers — Dockerfile and docker-compose

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

**The next step is data, not code.** Load real NSE history into the `candle`
table, run the five-year backtest and walk-forward validation, and let those
results decide whether any of these strategies deserves paper trading.

## Purpose

The purpose of the system is not to avoid losses completely. It is to achieve
positive long-term expectancy while protecting capital.
