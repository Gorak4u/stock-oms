# Deployment

There are two deployable artifacts in this repository, and they go to different
kinds of host. Conflating them is the mistake worth avoiding, because one of the
two failure modes is silent.

| Artifact | What it is | Where it goes |
| --- | --- | --- |
| **The platform** (`dist/main.js`) | Long-running process: tick loop, held database lock, websocket, ingestion timer | A container host — Fly.io, Render, Railway, ECS, a VPS |
| **The backtest console** (`public/index.html`) | One self-contained HTML file, the real engine compiled for the browser | Any static host — Vercel, Netlify, GitHub Pages, S3 |

## Why the platform cannot run serverless

This is not a configuration problem. Vercel, Netlify Functions, Cloudflare
Workers and Lambda all execute per request and freeze or discard the process in
between. The platform depends on the opposite:

- **The trading loop is a `setInterval`.** No requests means no ticks, so it
  would simply never trade — while looking perfectly healthy.
- **Leader election holds a Postgres advisory lock on a persistent session.**
  A new connection per invocation drops the lock constantly, and concurrent
  invocations produce the several simultaneous writers the lock exists to
  prevent. That failure mode places duplicate orders.
- **`/ws` is a long-lived websocket server.** Serverless cannot host one.
- **Market data ingestion and alert delivery are interval workers.**
- **The SIGTERM drain** — which stops the process exiting between persisting an
  order and hearing back from the broker — has nothing to hook into.
- **The pool opens up to 10 connections per instance**, which across many
  concurrent function instances exhausts Postgres.

Deploying it to a serverless host does not error. It comes up, serves the
dashboard, reports healthy, and never places a trade. That is why the split
above is worth being strict about.

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

## The backtest console

`vercel.json` builds `public/index.html` via `npm run build:static`. Nothing
else is required — no environment variables, no database, no secrets, because
the page is entirely self-contained.

```bash
npm run build:static     # produces public/index.html
npx vercel deploy        # or connect the repo in the Vercel dashboard
```

The same directory deploys to Netlify (publish `public/`, build
`npm run build:static`), GitHub Pages, or any object store.

It runs the **real engine** — the same strategy, risk, sizing, cost and fill
code as the Node build, compiled to the browser — so its results match
`npm run backtest` exactly. It reads synthetic data or your own OHLC CSV, and
shows which risk control refused each signal.

It is a research tool. It holds no keys, reaches no broker, and cannot place an
order. Publishing it exposes nothing about your account, which is precisely why
it is the piece that is safe to put on a public URL.
