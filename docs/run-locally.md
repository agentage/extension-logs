# Run it locally

The full local run of the extension with `up`, and the widget harness. The short steps are in the
README sections [Quick start](../README.md#quick-start) and [Verify](../README.md#verify).

Words used here:

- **kit**: `@agentage/extension`, the library that owns the servers, `/health`, auth and the scheduler.
- **store kind**: the type of database a part declares in `package.json`. Here it is `clickhouse`.

## Run the whole extension with `up`

`npx agentage extension up --docker` (kit 0.18 and later) runs a ClickHouse container for the `clickhouse` store kind and mounts its URL at `/run/secrets/store-url`. Nothing else is needed.

1. `npx agentage extension up --docker` - it builds the images from `HEAD`, so the repo needs one commit. The tree can be dirty.
2. Call it with a token that has the extension's scope: `T=$(npx agentage extension token --scope logs:admin)`, then `curl -H "Authorization: Bearer $T" "localhost:4280/api/logs/events?limit=5"`.
3. `npx agentage extension down` - one working copy holds ports 4280 and 4281 at a time.

`agentage extension token` sets no subject, so its token (subject `usr_dev`) gets 403 on
`POST /events`. Ingest needs a `svc_` subject. The harness seed below mints one. Without a token a
call answers 401.

## What CI runs

The job `Verify` runs `npm ci`, `npm run verify` and `agentage extension check`. It sets
`CLICKHOUSE_URL` to a ClickHouse 26.8 service, so the store tests run. The job `up and the
e2e gate on local` runs `up` (it starts its own ClickHouse), posts a line through the
gateway, runs `npm run test:e2e`, then runs the e2e gate of agentage/e2e (`.github/workflows/ci.yml`).

## Release

A released version is kept: a release never rebuilds it. The release record `agentage-extension.json`
names the images by digest.

## Widgets

Under `up`, the ui part serves the harness page of the widget kit. The seed posts sample data:

- 100 mixed lines: http, mcp, error, log, span, event, and one agcid with every kind.
- 5 `host.stats` samples with their containers. One sample is red (cpu 92).
- The services rows: one red by availability, one red by p95.

```bash
npx agentage extension up --docker                # with its own ClickHouse
npm run harness:seed                     # LOGS_URL and LOGS_ISSUER override 4280 and 4281
echo "http://localhost:4280/ui/$(jq -r .version package.json)/harness.html?widget=events&scope=logs:admin"
```

The seed mints its ingest token from the dev issuer with subject `svc_seed`
(`POST localhost:4281/token {"scope":"logs:write","sub":"svc_seed"}`). The seed posts to
`localhost` or `127.0.0.1` only.

URL options of the harness page:

- `?widget=events|hosts|services` picks one widget.
- `?scope=logs:admin` makes the dev issuer mint the admin token the reads need.
- `?q=` prefills the events search.
- `?theme=light|dark` sets the theme.

Each widget marks a row red and shows why in the state cell:

- `events`: level error.
- `hosts`: a sample older than 3 minutes, or cpu over 80, mem over 85 or disk over 80.
- `services`: availability under 99.0 %, or the worst route's p95 over 1000 ms. Edge rows are left
  out. Under 50 requests, availability shows a dash.

Run `npx playwright install chromium` once. Then `npm run test:e2e` runs the widget spec against
`up`. The spec checks the states, the red rule and axe WCAG A/AA.
