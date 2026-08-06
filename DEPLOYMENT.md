# Deployment

There are two deployable artifacts in this repository, and they go to different
kinds of host. Conflating them is the mistake worth avoiding, because one of the
two failure modes is silent.

| Artifact | What it is | Where it goes |
| --- | --- | --- |
| **The engine** (`dist/main.js`) | Long-running process: tick loop, held database lock, in-memory risk state, ingestion timer | A container host — Fly.io, Render, Railway, ECS, a VPS |
| **The backtest console** (`public/index.html`) | One self-contained HTML file, the real engine compiled for the browser | Any static host — Vercel, Netlify, GitHub Pages, S3 |
| **The trading dashboard** (`public/dashboard.html`) | A shell that reads a live engine over the API | Either — the engine serves it at `/`, or a static host points it at the engine |

Both *interfaces* can live on a CDN. Only the engine needs a real process.

## Why the engine cannot run serverless

This is not a configuration problem. Vercel, Netlify Functions, Cloudflare
Workers and Lambda all execute per request and freeze or discard the process in
between. The engine depends on the opposite — and the parts that break are the
ones that protect capital.

**Risk state lives in memory and would reset on every invocation:**

| State | Where | What breaks when it resets |
| --- | --- | --- |
| `squaredOffOn` | `runner.ts` | Square-off re-fires every tick for the last 20 minutes — roughly 20 duplicate market exit orders per position |
| `peakEquity`, `startOfDayEquity` | `tradingPipeline.ts` | Drawdown and daily-loss baselines reset to current equity, so **those kill switches never trigger** |
| `approvals` | `tradingPipeline.ts` | Staged orders vanish before anyone can approve them |
| Loss-streak breaker | `tradingPipeline.ts` | The circuit breaker never trips |

**And the mechanics do not survive either:**

- **The trading loop is a `setInterval`.** No requests means no ticks, so it
  would never trade — while looking perfectly healthy.
- **Leader election holds a Postgres advisory lock on a persistent session.**
  A new connection per invocation drops the lock constantly, and concurrent
  invocations produce the simultaneous writers the lock exists to prevent.
- **`/ws` is a long-lived websocket server.** Serverless cannot host one.
- **Market data ingestion and alert delivery are interval workers.**
- **The SIGTERM drain** — which stops the process exiting between persisting an
  order and hearing back from the broker — has nothing to hook into.
- **The pool opens up to 10 connections per instance**, which across many
  concurrent function instances exhausts Postgres.

Deploying it to a serverless host does not error. It comes up, serves the
dashboard, reports healthy, never places a trade — and if you did make it tick,
the loss limits would be silently inert. That is why the split above is worth
being strict about.

Making it serverless-safe is possible, but it means moving every row of that
first table into Postgres and driving ticks from cron. That is a rewrite of the
code that protects capital, in exchange for saving a few dollars a month on a
small always-on instance.

## The platform

Requirements: somewhere that runs a container, **Postgres 16**, and optionally
Redis (for durable alert delivery). Run **exactly one instance** — a second one
comes up read-only by design, so it costs money without trading.

### Fly.io

`fly.toml` is in the repo. The setting that matters most is
`auto_stop_machines = false`: Fly suspends idle machines by default, and a
suspended machine runs no tick loop.

```bash
fly launch --no-deploy --copy-config
fly postgres create --name stock-oms-db --region bom
fly postgres attach stock-oms-db                    # sets DATABASE_URL
fly secrets set API_TOKEN=$(openssl rand -hex 24)
fly deploy
```

### Render

`render.yaml` is a Blueprint that provisions the service, Postgres and Redis
together. Push it, then **New → Blueprint** in the dashboard. Read the generated
`API_TOKEN` from the service's environment tab.

### Railway

Needs no config file — it builds the `Dockerfile` directly. Add a Postgres
plugin, set `API_TOKEN`, and confirm the health check path is `/health`.

### A VPS

`docker-compose.yml` already describes the whole stack:

```bash
export API_TOKEN=$(openssl rand -hex 24)
docker compose up -d --build
```

Put a reverse proxy with TLS in front. Do not expose port 8080 directly — the
API is token-authenticated, but it should not also be the TLS terminator.

### After the first deploy

1. **Load history.** The `candle` table starts empty and an empty table means a
   loop that ticks quietly forever without trading. See
   [Loading market data](README.md#loading-market-data).
2. **Check `/health`.** The `market-data` check reports stale or absent data as
   unhealthy during a session — it is the one that catches an inert system.
3. **Leave `BROKER=paper`** until a backtest and walk-forward on real history
   say otherwise.

### Deploys and restarts

A rolling deploy is safe. The new instance starts while the old still holds the
lock, comes up read-only, and promotes itself when the old one releases —
usually within `LEADER_RETRY_MS` (15s default). The old instance drains a tick
in flight before exiting, so give the orchestrator at least 45 seconds before it
resorts to SIGKILL. `docker-compose.yml` sets `stop_grace_period: 45s` and
`fly.toml` sets `kill_timeout = "45s"` for this reason.

## The interfaces on a CDN

`npm run build:static` produces a `public/` directory with three files:

```
public/index.html       the backtest console (also at /console.html)
public/dashboard.html   the trading dashboard
public/console.html
```

`vercel.json` already wires this up, so a Vercel deploy needs no environment
variables and no secrets. The same directory works on Netlify (publish
`public/`, build `npm run build:static`), GitHub Pages, or any object store.

```bash
npm run build:static
npx vercel deploy        # or connect the repo in the Vercel dashboard
```

### The console

Runs the **real engine** — the same strategy, risk, sizing, cost and fill code
as the Node build, compiled to the browser — so its results match
`npm run backtest` exactly. It reads synthetic data or your own OHLC CSV and
shows which risk control refused each signal.

It holds no keys, reaches no broker, and cannot place an order. Publishing it
exposes nothing about your account, which is why it is safe on a public URL.

### The dashboard, pointed at a remote engine

The dashboard is a shell; every figure arrives over the API. When a CDN serves
it, it needs to know where the engine is:

1. Open the deployed dashboard and put the engine's public URL in the **API
   URL** field — e.g. `https://stock-oms.fly.dev`. Stored in `localStorage`,
   because an endpoint is configuration, not a secret.
2. Put the API token in the **API token** field. Stored in `sessionStorage`, so
   it does not outlive the browser session on a shared machine.

Then tell the engine to accept that origin, or the browser will block every
request:

```bash
fly secrets set CORS_ORIGINS=https://stock-oms.vercel.app
```

`CORS_ORIGINS` is default-deny — with nothing set, no browser origin may read
the API. It is also not a grant of access: an allowed origin with no token
still gets a 401. It only decides which page is permitted to *read a response*
it was already authorised to receive.

Leave the API URL blank when the engine serves the dashboard itself — that is
the same-origin case and needs no CORS at all.

### The content security policy

`vercel.json` sets a `default-src 'none'` policy, with two deliberate openings:

- **`script-src`/`style-src 'unsafe-inline'`** — the console inlines the whole
  engine and its styles into one file. That is what makes it self-contained.
- **`connect-src https: wss:`** plus localhost — the dashboard's API endpoint is
  typed in at runtime, so it cannot be a fixed allowlist. Localhost is included
  so the same published page can drive an engine on your own machine.

Everything else stays denied: no frames, no form posts, no base-URI rewriting.

`vercel.json` is validated in CI by `scripts/check-vercel-config.js`. Vercel
rejects unknown properties rather than ignoring them — and since JSON has no
comment syntax, the tempting `"comment"` key next to a header is exactly what
gets rejected, at deploy time. Hence the check, and hence this section rather
than a comment in the file.

### A note on what this publishes

Putting the dashboard on a public URL publishes the *shell*, not the data. It
contains no token and no endpoint until someone types them in, and the build
refuses to stage a dashboard with a hard-coded token in it. Anyone who opens it
without your token sees an empty page.

The engine remains the thing to protect. `API_PUBLIC_READS` stays `false`.
