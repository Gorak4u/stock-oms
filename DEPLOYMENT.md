# Deployment

**This is one application.** One build, one process, one URL:

| Route | What |
| --- | --- |
| `/` | Trading dashboard |
| `/console` | Backtest console |
| `/api/*` | REST API |
| `/ws` | Live status stream |
| `/health`, `/metrics` | Probes |

```bash
npm run build && npm start
```

Deploy it to anything that runs a container or a long-lived Node process —
Fly.io, Render, Railway, a VPS. `fly.toml`, `render.yaml` and
`docker-compose.yml` are in the repo. That is the whole story; the rest of this
document is detail.

## What it needs

Node 20+, **Postgres 16**, and optionally Redis (for durable alert delivery).
Run **exactly one instance** — a second comes up read-only by design, so it
costs money without trading.

It cannot run on a serverless host. Not a config problem, and not merely the
websocket: see [why](#why-the-engine-cannot-run-serverless) below.

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

## Hosts

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

   To confirm the deployment works before you have real data, seed it:
   `npm run seed -- --reset` against the deployed `DATABASE_URL` fills every
   screen by driving the real pipeline. Clear it again with `--reset` before
   loading actual history — the seed refuses to mix synthetic bars into a
   database that already holds candles, because afterwards there is no way to
   tell the two apart.
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

## Optional: the pages on a CDN as well

**You do not need this.** The application serves both pages itself, and one
deploy is the simpler and intended setup. This section exists for one case:
publishing the backtest console on a public URL without exposing the engine
that trades.

The console holds no keys, reaches no broker, and cannot place an order — it is
the platform core compiled for the browser, computing everything client-side
from data you give it. That makes it safe to publish in a way the engine is not.

```bash
npm run build:static     # → public/
npx vercel deploy        # vercel.json is already wired up; no env vars, no secrets
```

`public/` mirrors the application's own routes — `index.html` is the dashboard,
`console.html` the console — so links behave identically whichever serves them.
The same directory works on Netlify, GitHub Pages, or any object store.

### Pointing a CDN-hosted dashboard at the engine

Only relevant if you serve the dashboard from the CDN too. It is a shell; every
figure arrives over the API, so it needs to know where the engine is:

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
