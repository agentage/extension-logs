# extension-logs

The logs extension: every part's telemetry line (one JSON line per unit of work) lands in one
ClickHouse `events` table; the api serves ingest, search, trace, stats and hosts, the mcp part
five tools on the same SQL, the worker a nightly `retention` check, the ui three widgets. Each
part is only `create(ctx)`; the kit [`@agentage/extension`](https://github.com/agentage/platform)
owns servers, `/health`, auth, the scheduler and the images.

| Part   | Source                              | Serves                                                                  |
| ------ | ----------------------------------- | ----------------------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/v1/events`, `/traces/{agcid}`, `/stats`, `/hosts`, `openapi.json` |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json))             |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                                |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                               |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)                  |

The line is `EventSchema` of `@agentage/extension/logs`; the ingest adds two rules (a `ts` inside
the 30-day TTL, a `usr_` or `svc_` subject). The api, mcp and worker read the store connection
from the file the estate mounts, `/run/secrets/store-url` (`http://logs:{pw}@logs_store:8123/logs`:
user, password, host, database), on first use; `/health` of the api carries `checks.clickhouse`
(a `SELECT 1`, bounded under 1 s).

## Ingest and the store's limits

One `POST /events` batch (at most 1000 lines, 1 MB) is one ClickHouse insert. An answer is
`accepted: N` only after the store has the rows; a failed insert answers 503 `UNAVAILABLE` (the
store down, slow past 10 s, or at one of its limits) or 500 `INTERNAL`, never a count. A retry is
safe: ClickHouse 26.8 inserts async by default and keeps no dedup window on a non-replicated
MergeTree, so the api sets `non_replicated_deduplication_window = 1000` on the table and sends
each batch with a token (the sha256 of its rows); the same batch again stores nothing, even when
the first attempt landed after its 503. Two identical batches sent on purpose count once.

Every read runs with `max_execution_time` 9 s, `max_memory_usage` 256 MB and `max_result_rows`
10000 (throw, never a silent cut), so one wide query cannot take the 2 GB store; past a limit the
read answers 503 `UNAVAILABLE` "The store is busy: narrow the query or retry". `/stats` returns
the top 1000 groups by calls.

## Scopes

Any account can mint `logs:read` and `logs:write` for itself, so neither opens a read; only an
admin mints `logs:admin` or a service subject (`svc_`).

| Call                                                                             | Needs                                   | Else                                            |
| -------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `POST /events`                                                                   | `logs:write` and a `svc_` token subject | 403 `FORBIDDEN` "ingest needs a service token"  |
| `GET /events`, `/traces/{agcid}`, `/stats`, `/hosts`, `/hosts/{host}/containers` | `logs:admin`                            | 403, `WWW-Authenticate: ... scope="logs:admin"` |
| every `logs__*` tool                                                             | `logs:admin`                            | 403                                             |

## Run

Needs Node 22+, npm 10+, Docker, `git` and `jq`.

```bash
npm ci && npm run verify                 # type-check, lint, format, tests, build
npx agentage extension check             # PASS logs {version} conforms
```

`up` runs no ClickHouse and mounts only declared secrets, while the estate refuses a declared
`store-url`. So a local run starts its own ClickHouse and declares `store-url` for that run only,
as `ci.yml` does; never commit that line.

```bash
docker run -d --name logs-store -p 8123:8123 -e CLICKHOUSE_PASSWORD=local clickhouse/clickhouse-server:26.8
jq '.agentage.secrets = ["store-url"]' package.json > p.json && mv p.json package.json
AGENTAGE_SECRET_STORE_URL=http://default:local@172.17.0.1:8123 npx agentage extension up
git checkout package.json                # after up: the images are built
```

## Release

Set the version, `npx agentage extension check --write`, merge, push the tag `v{version}` on master.
`release.yml` pushes the part images to `ghcr.io/agentage/logs-{part}` and attaches
`agentage-extension.json` (the images by digest) to the GitHub release; the estate pins those.
The package is `private`: no npm publish.

## Widgets in the harness

The ui part serves the widget kit's harness page under `up`; the seed posts 100 mixed lines
(http, mcp, error, log, span, event, one agcid with every kind), 5 `host.stats` samples (one red,
cpu 92) with their containers, and the services rows (one red by availability, one by p95).

```bash
npx agentage extension up                # with ClickHouse and store-url, see Run
npm run harness:seed                     # LOGS_URL and LOGS_ISSUER override 4280 and 4281
echo "http://localhost:4280/ui/$(jq -r .version package.json)/harness.html?widget=events&scope=logs:admin"
```

The seed mints its ingest token from the dev issuer with subject `svc_seed`
(`POST localhost:4281/token {"scope":"logs:write","sub":"svc_seed"}`): `agentage extension token`
sets no subject, so its `usr_dev` token gets 403 on `POST /events`.
`?widget=events|hosts|services` picks one widget, `?scope=logs:admin` makes the dev issuer mint
the admin token the reads need, `?q=` prefills the events search, `?theme=light|dark` the theme.
A row is red, its reason in the state cell, by: `events` level error; `hosts` the api's `red`
(a sample older than 3 min, cpu > 80, mem > 85 or disk > 80); `services` (edge rows left out)
availability under 99.0 % (a dash under 50 requests) or the worst route's p95 over 1000 ms.
The seed posts to `localhost` or `127.0.0.1` only.
`npm run test:e2e` runs the widget spec (states, the red rule, axe WCAG A/AA) against `up`.

## License

MIT
