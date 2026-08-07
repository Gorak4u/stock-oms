# Deployment

**This is one application.** Two ways to run it, and both serve everything from
one URL:

| | Always-on process | Vercel |
| --- | --- | --- |
| Runs on | Fly.io, Render, Railway, a VPS | Vercel, one deploy |
| Tick | its own `setInterval` | Vercel Cron calling `/api/tick` |
| Single-writer guard | Postgres advisory lock | a lease row with an expiry |
| Live status | websocket, plus 10s polling | 10s polling |
| Paper broker | works | **cannot fill** — see below |
| Tick reliability | as reliable as the process | best-effort cron delivery |

Vercel is the simpler operation and genuinely works, with real constraints
listed under [Vercel](#vercel). An always-on process is the stronger foundation.
Pick by what you are doing, not by which sounds more serious.

## The always-on process

One build, one process, one URL:

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

For the Vercel path instead, see [Vercel](#vercel).

## What had to change to run per-invocation

This is recorded because the reasoning matters more than the outcome: for most
of this project's life, deploying to a serverless host would have produced a
system that looked healthy and had no working risk controls.

Four pieces of state lived only in memory, and none of them derive from
anything, so replaying fills could not rebuild them:

| State | What broke when it reset |
| --- | --- |
| `peakEquity`, `startOfDayEquity` | Drawdown and daily-loss baselines reset to current equity, so **those kill switches never triggered** |
| Loss-streak breaker | The circuit breaker never tripped |
| `squaredOffOn` | Square-off re-fired every tick for the last twenty minutes — roughly twenty duplicate exit orders per position |
| Staged approvals | Orders vanished before anyone could approve them |

All four are now snapshotted and restored, which fixed a live bug in the
always-on deployment too: a restart there had exactly the same effect. That is
the change that made a per-invocation tick viable at all. The advisory lock was
then replaced by a lease for the same job, since there is no long-lived
connection for a lock to live on.

**What is still weaker, and always will be:**

- Cron delivery is best-effort, where a `setInterval` in a live process is not.
- The lease is bounded by a clock, where the advisory lock is released by the
  database noticing a dead connection. A stalled-but-alive invocation can
  overlap the next one; idempotency keys sit underneath, but the guarantee is
  softer.
- The paper broker cannot fill, because its state is in memory.
- Every cold start pays to rebuild state and replay the fill history.

None of that makes the Vercel path wrong. It makes it the right tool for a
dashboard, a console, daily bars and paper-money experimentation, and the wrong
one for minute bars against real capital.

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

## Vercel

One deploy serves the dashboard, the console, the API and the scheduled tick.
`vercel.json` is already wired up.

```bash
vercel link
vercel env add DATABASE_URL      # a serverless Postgres: Vercel Postgres, Neon, Supabase
vercel env add API_TOKEN         # openssl rand -hex 24
vercel env add CRON_SECRET       # openssl rand -hex 24
vercel deploy --prod
```

Then `/` is the dashboard, `/console` the backtest console, `/api/*` the API.
Paste the API token into the dashboard; leave its **API URL** field blank, since
everything is same-origin.

### How it runs

`api/index.ts` hands every request to the same Fastify app the always-on process
builds — there is no second implementation of any route. The application is
rebuilt from the database per cold start and cached while the container stays
warm.

Vercel Cron calls `POST /api/tick` on a schedule. Each tick ingests, then runs
one iteration of the same loop, under a lease so two overlapping deliveries
cannot both decide. The default schedule is `*/5 3-10 * * 1-5` — every five
minutes through the NSE session, **in UTC**, which is 09:15–15:30 IST.

This works at all only because the pipeline's risk state and the square-off
guard are persisted. Before that, a per-invocation deployment reset the drawdown
peak on every tick and left the daily-loss and drawdown kill switches
permanently inert, while every dashboard showed green.

### What you must check before trusting it

- **Paper trading does not work here.** The paper broker keeps its resting
  orders, cash and fills in memory, so it is rebuilt on every invocation and a
  submitted order is gone before it can fill. Seeded history displays correctly
  and the console works fully, but no *new* order will ever fill. `/health`
  reports the broker as degraded rather than pretending otherwise. Use
  `BROKER=zerodha`, whose state lives at the broker, or run the always-on
  process for paper trading.
- **Cron frequency depends on your Vercel plan.** Sub-daily schedules are a paid
  feature; on the free tier a cron fires once a day, which supports daily-bar
  strategies and nothing faster. Check your plan before assuming five-minute
  ticks.
- **Cron delivery is best-effort.** A missed tick during a fast move is a missed
  stop-loss. The `tick` health check reports when ticks stop arriving, which is
  the failure a scheduled loop has and a self-scheduled one does not.
- **Use a Postgres built for serverless.** Vercel Postgres, Neon or Supabase
  pool connections; a plain instance will exhaust its connection limit as
  invocations scale.
- **Function duration is capped.** A tick over many symbols must finish inside
  it. `maxDuration` in `vercel.json` is set to 60s; the ceiling depends on plan.

### Verifying a deploy

```bash
curl https://your-app.vercel.app/health
curl -H "Authorization: Bearer $API_TOKEN" https://your-app.vercel.app/api/status
curl -X POST -H "Authorization: Bearer $API_TOKEN" https://your-app.vercel.app/api/tick
```

The tick returns `{"ran":true,...}`, or `{"ran":false,"reason":"another
invocation holds the tick lease"}` — which is the guard working, not an error.

To fill the dashboard before you have real history, point `DATABASE_URL` at the
deployed database and run `npm run seed -- --reset` locally.

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
