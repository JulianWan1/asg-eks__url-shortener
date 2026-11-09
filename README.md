# url-shortener

The stateless workload for the **devops-lab** project. It is deliberately
simple: its job is to be *too simple to be wrong*, so that when something breaks
during the infrastructure phases, you know it's the infrastructure — never the
app.

TypeScript · Express · Postgres. All state lives in the database, so every
instance and pod is disposable.

## Run it locally (no AWS, no Terraform)

The fastest path — needs only Docker:

```bash
docker compose up --build
```

That starts Postgres and the app together. The app waits for the DB and
self-migrates on boot, so there are no setup steps.

Or run against your own Postgres without Docker:

```bash
cp .env.example .env      # edit DATABASE_URL if needed
npm install               # also generates package-lock.json (commit it)
npm run dev               # hot-reload via tsx
```

> **Lockfile note:** this scaffold ships without a `package-lock.json`, so the
> Dockerfile uses `npm install`. Run `npm install` once, commit the resulting
> `package-lock.json`, then switch the Dockerfile's `RUN npm install` back to
> `RUN npm ci` for faster, fully-reproducible builds.

## Try the endpoints

```bash
# create a short code
curl -s -X POST localhost:3000/shorten \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/long/path"}'
# -> {"code":"aB3xK9q"}

# follow the redirect (‑L) to the original URL
curl -sL localhost:3000/aB3xK9q

# liveness (no DB) and readiness (checks DB)
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz

# burn CPU for 800ms — your autoscaling trigger
curl -s "localhost:3000/work?ms=800"

# prometheus metrics (used in the Kubernetes step)
curl -s localhost:3000/metrics | head
```

## Endpoint reference

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /shorten` | Store a URL, return a code | Body: `{"url":"https://…"}`; validates http(s) |
| `GET /:code` | 302 redirect to the original URL | 404 if unknown |
| `GET /healthz` | **Liveness** — process alive? | No DB call; stays green while draining |
| `GET /readyz` | **Readiness** — can it serve now? | Checks DB; 503 during shutdown → LB stops traffic |
| `GET /work?ms=N` | Burn CPU for N ms | Capped at 10s; triggers scaling on demand |
| `GET /metrics` | Prometheus metrics | Ignore until the Kubernetes step |

## Design rules (why the code looks the way it does)

- **Config from the environment only** (`src/config.ts`) — same image runs
  locally, on EC2, and in a pod with just different env vars. Fails fast if
  `DATABASE_URL` is missing.
- **Self-migrate on startup** (`src/db.ts`) — a fresh empty database just works,
  which is what makes the nightly destroy-and-recreate cycle painless.
- **Graceful SIGTERM shutdown** (`src/server.ts`) — flips readiness off, drains
  in-flight requests, closes the pool, exits. This is what makes rolling
  deploys zero-downtime.
- **Multi-stage Docker build** (`Dockerfile`) — slim non-root runtime with only
  compiled output + production deps.

## Layout

```
src/
  config.ts     env parsing + validation (fail fast)
  logger.ts     structured JSON logs to stdout
  db.ts         pg pool, connection retry, self-migrate
  shortcode.ts  random base62 code generation
  metrics.ts    prometheus registry + request histogram
  app.ts        express app + the six routes
  server.ts     bootstrap + graceful shutdown
```
