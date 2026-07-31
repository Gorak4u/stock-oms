# AI Trading Platform

A resilient, auditable, single-user automated NSE trading platform.

> **Status: research and paper-trading core.** The deterministic spine —
> market data, features, strategies, model gating, risk, execution and
> backtesting — is implemented and tested. The service layer around it (HTTP
> API, dashboards, Redis/BullMQ, real broker connectors, monitoring stack) is
> not yet built. See [Roadmap](#roadmap) for exactly what is and is not here.
>
> **Do not point this at a live broker account yet.** Nothing has traded real
> money, and the acceptance criteria below are unmet by construction.

---

## Why the core came first

The architecture describes nine layers. They are not equally risky. A dashboard
that renders wrong is embarrassing; a position sizer that rounds the wrong way,
a fill simulator that is too optimistic, or an order path that duplicates on
retry costs money and is hard to detect after the fact.

So the first milestone is the part where mistakes are expensive and testing is
possible: the deterministic path from a bar of market data to an order, plus
the backtester that lets you find out whether a strategy is worth trading at
all. Every layer above it is I/O around this core.

That ordering also matches the project's own acceptance criteria, which run
backtest → walk-forward → paper → small live. You cannot start at step one
without a backtester you trust.

## Design commitments

These are enforced by tests, not just intended.

**Money is integer paise.** No monetary value is ever a float. `0.1 + 0.2` is a
rounding curiosity in a spreadsheet and a reconciliation break in an execution
path. See `src/domain/money.ts`.

**No lookahead.** Indicators return arrays aligned to their input with `null`
through the warm-up, and strategies may only read up to the current index. The
backtester decides on a bar's close and fills on the *next* bar's open. A test
runs the same prefix inside two series with different futures and asserts the
equity curves are identical — if a strategy could see ahead, they would differ.

**Determinism.** Same inputs, same outputs, everywhere. Strategies do no I/O and
consult no clock. Model training is full-batch with a fixed iteration count and
no randomness. A backtest run twice produces byte-identical results, and an
audit log written today can be replayed tomorrow.

**One intent, one order.** Idempotency keys are derived from the trade intent
(strategy, symbol, side, quantity, decision bar), not randomly generated, so a
retry after a crash re-derives the same key and is refused. An order is
persisted as `PENDING_NEW` *before* the broker call, and a submission whose
outcome is unknown is never blindly retried — it is reconciled against the
broker.

**Risk-reducing orders are never blocked.** Every risk control can stop an order
that opens exposure. None may stop one that closes it. A control that traps the
account in a losing position while the market runs away is worse than no
control.

**Costs always apply.** Brokerage, STT, exchange charges, GST, SEBI fees, stamp
duty and slippage are modelled and charged in every backtest. On NSE intraday a
round trip costs roughly 0.05–0.12% of turnover; a strategy with a 0.08% gross
edge is a losing strategy, and only a cost model reveals that.

**The model can only veto.** The AI layer filters signals the strategy layer
already produced. It cannot originate a trade, choose a direction, or enlarge a
position. Its worst case is bounded: it stops the system trading. It also fails
*open* — no promoted model, a thrown exception, missing features or detected
drift all pass the signal through untouched, leaving the strategy and risk
layers to stand on their own.

## Layout

```
src/
  domain/        money (integer paise), core types
  marketdata/    NSE calendar, tick→OHLC, validation, corporate actions
  features/      technical indicators
  ai/            feature extraction, logistic baseline, drift, registry, inference
  strategy/      trend following, mean reversion, momentum, volatility breakout
  risk/          position sizing, the risk engine, kill switch
  execution/     costs, broker interface, paper broker, portfolio, OMS
  backtest/      metrics, backtest engine, walk-forward validation
  pipeline/      the live workflow spine
  audit/         hash-chained append-only log
```

## Getting started

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # 276 tests
npm run backtest      # runnable demo over a synthetic series
```

Requires Node 20+. The core has **zero runtime dependencies** — only dev
tooling. That is deliberate: the deterministic path should not be able to break
because a transitive dependency changed.

## The workflow

```
market data → features → strategy → AI → risk → execution → broker
```

`TradingPipeline` (`src/pipeline/tradingPipeline.ts`) sequences those layers and
holds no trading logic itself. `BacktestEngine` drives the *same* components
against history. Anything simulated in one and reimplemented in the other is a
place the two can silently disagree, so the only simulated pieces are the clock
and the exchange.

### Automation modes

| Mode | Behaviour |
| --- | --- |
| `MANUAL` | Signals recorded, orders staged, nothing sent. |
| `APPROVAL` | Orders staged and wait for explicit approval. Risk is **re-checked at approval time** — a verdict from minutes ago may have been overtaken by a drawdown or a tripped breaker. |
| `AUTOMATIC` | Orders sent as soon as they clear risk. |

Mode changes are audited: "who turned automatic trading on, and when" is the
first question asked after an incident.

## Risk controls

Configured in `src/risk/types.ts`; defaults are deliberately tighter than most
traders would pick, because a too-tight limit costs a missed trade and a
too-loose one costs an account.

| Control | Default | Behaviour |
| --- | --- | --- |
| Risk per trade | 1% of equity | Sizes the position from the stop distance |
| Max position value | 10% of equity | Scales the order down |
| Gross exposure | 100% of equity | Scales down |
| Net exposure | 75% of equity | Scales down |
| Symbol concentration | 15% of equity | Scales down |
| Daily loss limit | 3% of start-of-day equity | Halts |
| Max drawdown | 15% from peak | Halts |
| Max open positions | 10 | Halts |
| Consecutive losses | 4 | Halts |
| Order rate | 30/minute | Halts (runaway-loop guard) |
| Stop-loss required | on | Rejects entries with no protective stop |
| Emergency stop | manual | Blocks all risk-increasing orders until released |

State controls (halts) reject outright. Size controls scale the quantity down
instead — trading less is a sensible response to "this order is too big", but
not to "the system should not be trading at all".

## Backtesting

```ts
const engine = new BacktestEngine({
  openingCash: fromRupees(1_000_000),
  limits: DEFAULT_RISK_LIMITS,
  useTrailingStops: true,
});

const result = await engine.run(new TrendFollowingStrategy(), candles);
console.log(result.metrics.sharpe, result.metrics.drawdown.maxDrawdown);
```

Results carry the equity curve, closed trades, every signal, every risk
rejection with its reason, every model veto, and the audit log — so a
surprising number can always be traced back to the decision that produced it.

### Walk-forward validation

A single backtest over tuned parameters proves nothing; with enough parameters
any series can be fitted. `walkForward` selects parameters on a training window
and evaluates them, untouched, on the window that follows, rolling forward. Only
the out-of-sample results are reported.

The `efficiency` figure is out-of-sample ÷ in-sample performance. Near 1 means
the edge survived. Well below 1 means the parameters were fitted to noise and
the strategy should not be traded.

## Roadmap

Implemented:

- [x] Market data — NSE calendar, tick→OHLC, validation, corporate actions
- [x] Feature engineering — indicators, extraction, scaling
- [x] AI — logistic baseline, model registry with gated promotion, PSI drift detection, inference gating
- [x] Strategies — trend following, mean reversion, momentum, volatility breakout
- [x] Risk — sizing, all controls above, kill switch
- [x] Execution — cost model, broker interface with failover, paper broker, portfolio, OMS
- [x] Backtesting — engine, metrics, walk-forward
- [x] Audit — hash-chained append-only log
- [x] Pipeline — the workflow spine with automation modes

Not yet built:

- [ ] API layer — Fastify, REST/GraphQL/WebSocket, auth
- [ ] Front end — trading, portfolio, options, backtesting, admin dashboards
- [ ] Messaging — Redis, BullMQ, event and retry queues
- [ ] Persistence — Postgres schema and migrations, object storage
- [ ] Real broker connectors (the interface and a failover wrapper exist; no live implementation)
- [ ] Options strategies and an options pricing layer
- [ ] Training pipeline and feature store as services
- [ ] Monitoring — metrics, error tracking, health checks, alerting, reconciliation jobs
- [ ] Containers and deployment

## Acceptance criteria

None of these are met yet, and the gap is the point of listing them:

- [ ] Five years of backtesting on real NSE data (the engine exists; the data does not)
- [ ] Walk-forward validation on that data
- [ ] Paper trading
- [ ] Live testing with small capital
- [ ] Continuous monitoring

## Purpose

The purpose of the system is not to avoid losses completely. It is to achieve
positive long-term expectancy while protecting capital.
