# Run it locally

The full local run of the extension with `up`, and the widget harness. The basic steps (`npm ci`,
`verify`, ClickHouse for the store tests) are in the README section
[Run it locally](../README.md#run-it-locally).

Words used here:

- **kit**: `@agentage/extension`, the library that owns the servers, `/health`, auth and the scheduler.
- **store kind**: the type of database a part declares in `package.json`. Here it is `clickhouse`.

## Run the whole extension with `up`

`npx agentage extension up` does not run ClickHouse. This extension needs a store kind that `up`
cannot start, so a plain `up` fails. You see this line:

```text
FAIL api /health status unavailable, needs ok or degraded
```

To run it, start the ClickHouse container from the README. Then declare the `store-url` secret for
this run only. The estate refuses a declared `store-url`, so never commit the edit. `172.17.0.1` is
the docker host as the parts see it.

1. `jq '.agentage.secrets = ["store-url"]' package.json > p.json && mv p.json package.json`
2. `export AGENTAGE_SECRET_STORE_URL=http://logs:local@172.17.0.1:8123/logs`
3. `npx agentage extension up` - `up` builds the images from `HEAD`, so the repo needs one commit. The tree can be dirty.
4. `git checkout package.json` - the images are built, so undo the edit now.
5. Call it with a token that has the extension's scope: `T=$(npx agentage extension token --scope logs:admin)`, then `curl -H "Authorization: Bearer $T" "localhost:4280/api/v1/events?limit=5"`.
6. `npx agentage extension down` - one working copy holds ports 4280 and 4281 at a time.

`agentage extension token` sets no subject, so its token (subject `usr_dev`) gets 403 on
`POST /events`. Ingest needs a `svc_` subject. The harness seed below mints one. Without a token a
call answers 401.

## What CI runs

The job `Verify` runs `npm ci`, `npm run verify` and `agentage extension check`. The job `up and the
e2e gate on local` starts ClickHouse 26.8, declares `store-url`, runs `up`, posts a line through the
gateway, runs `npm run test:e2e`, then runs the e2e gate of agentage/e2e (`.github/workflows/ci.yml`).

## Widgets

Under `up`, the ui part serves the harness page of the widget kit. The seed posts sample data:

- 100 mixed lines: http, mcp, error, log, span, event, and one agcid with every kind.
- 5 `host.stats` samples with their containers. One sample is red (cpu 92).
- The services rows: one red by availability, one red by p95.

```bash
npx agentage extension up                # with ClickHouse and store-url, see above
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
