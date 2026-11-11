# extension-logs

The logs extension: every part's telemetry line (one JSON line per unit of work) lands in one
ClickHouse `events` table; the api serves ingest and two reads (rows and groups, below), the mcp
part the same two reads as tools, the worker a nightly `retention` check, the ui three widgets. Each
part is only `create(ctx)`; the kit [`@agentage/extension`](https://github.com/agentage/platform)
owns servers, `/health`, auth, the scheduler and the images.

| Part   | Source                              | Serves                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/v1/events`, `/stats`, `openapi.json`                  |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json)) |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                    |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                   |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)      |

The line is `EventSchema` of `@agentage/extension/logs`; the ingest adds two rules (a `ts` inside
the 30-day TTL, a subject that is an opaque id `[A-Za-z0-9_-]{1,64}`, never an email). The api, mcp and worker read the store connection
from the file the estate mounts, `/run/secrets/store-url` (`http://logs:{pw}@logs_store:8123/logs`:
user, password, host, database), on first use; `/health` of the api carries `checks.clickhouse`
(a `SELECT 1`) and `checks.disk` (the free bytes of the events table's disks in `system.disks`,
the estate's 1 GiB reserve included: under 1.5 GiB, or unreadable, `degraded`, never `unavailable`,
so a full disk stops the ingest with 503 while the reads still answer), each bounded at 900 ms.

## Ingest and the store's limits

One `POST /events` batch (at most 1000 lines, 1 MB) is one ClickHouse insert. An answer is
`accepted: N` only after the store has the rows; a failed insert answers 503 `UNAVAILABLE` (the
store down, slow past 10 s, at one of its limits, or unable to write: no space, a read-only table)
or 500 `INTERNAL`, never a count. A retry is
safe: ClickHouse 26.8 inserts async by default and keeps no dedup window on a non-replicated
MergeTree, so the api sets `non_replicated_deduplication_window = 1000` on the table and sends
each batch with a token (the sha256 of its rows); the same batch again stores nothing, even when
the first attempt landed after its 503. Two identical batches sent on purpose count once. The
window counts inserts, not time: a retry more than 1000 inserts later is stored again. The api
runs the `ALTER` only when `SHOW CREATE TABLE events` lacks the setting.

Every read runs with `max_execution_time` 9 s, `max_memory_usage` 256 MB and `max_result_rows`
10000 (throw, never a silent cut), so one wide query cannot take the 2 GB store; past a limit the
read answers 503 `UNAVAILABLE` "The store is busy: narrow the query or retry". `/stats` pages
(below); the `services` widget reads it through `logs__aggregate` and shows `truncated` in its
caption.

## The two reads

`GET /api/v1/events` (tool `logs__query`) answers rows; `GET /api/v1/stats` with `kind` (tool
`logs__aggregate`) answers groups. Both take `kind` and the same filters: `since` and `until`
(`15m`, `2h`, `7d` or an ISO time), `extension`, `part`, `host`, `level`, `route`, `status`, `agcid`,
`sub`, `ok` (`true` or `false`), `name` (what `by=name` groups: the event name on `event`, `any` or no kind, the container name
on `container`; another kind is a 400), `q` (text in msg, or an
agcid); `/stats` also `user_type`.

- `/events` adds `order` (`desc`, newest first, or `asc`), `sort` (`ts`, or `ms` for the slowest
  first, ties by time), `limit` (at most 1000) and `cursor` (bound to its query: sent with another kind, filter, sort or order it is a 400).
- `/stats` adds `by` (a comma list), `bucket` (`1m`, `5m`, `1h`, `1d`), `under` (ms, `http` and `mcp`:
  adds the measure `under`, the share of the group's rows at or under it), `sort` (a measure or a `by` name;
  any other name is a 400 that lists the allowed ones), `order`, `limit` (100, at most 1000) and
  `cursor`. A group without a value sorts last. `meta.nextCursor` pins the window of page 1, so
  every page is cut from the same rows; a cursor sent with another kind, `by`, sort, order or filter
  is a 400. Page 1 ends 5 s before now (unless `until` is given), so a late row cannot move a group
  between pages. A `bucket` draws at most 1500 steps, and a call groups at most 100000 groups (past
  it, 503 busy). `kind` is required: without it, or with `window` (the 0.2 form, gone in 0.5),
  `/stats` is a 400. `kind` also takes the lists whose kinds share measures,
  `http,mcp` (one number over both, quantiles and users over the union) and `log,event`, in either
  order (another list is a 400 that names the allowed ones), and `any` (every row: count, firstSeen, lastSeen); both add `kind` to `by`.
  Quantiles, averages and percents answer at most 2 decimals, availability and `under` 4.

| kind                                  | `/stats` measures, per group                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `http`, `mcp`                         | calls, failed, requests, availability, p50, p95, p99, users, firstSeen, lastSeen, agcid (with `under`: under) |
| `job`                                 | runs, failed, p50, p95                                                                                        |
| `span`                                | count, p50, p95, p99                                                                                          |
| `error`                               | count, lastSeen, sample, agcid                                                                                |
| `log`, `event`                        | count                                                                                                         |
| `host` (event `host.stats`)           | cpu, cpu_avg, cpu_max, mem, mem_max, disk, disk_max, load1, containers, at                                    |
| `container` (event `container.stats`) | cpu, cpu_avg, cpu_max, mem, mem_max, limit, at                                                                |
| `any` (every kind)                    | count, firstSeen, lastSeen                                                                                    |

`by` takes `extension`, `part`, `route`, `method`, `status`, `host`, `level`, `client`, `user_type`,
`sub`, `version`; `error` adds `type`, `fingerprint`; `event` and `any` add `name` (the event name),
`container` adds `name` (the container name); a list of kinds and `any` add `kind`. availability is the admin
console's formula (5xx, and 502 to 504 at the edge, against requests; a 429 is no request; null under
50 requests); tests and services are left out of `http` and `mcp` unless the call filters on or
groups by `user_type`. A
`host` or `container` sample is the newest without `bucket` and the step's average with it. The
default window is 24 h (`host` 1 h, `container` 5 min); the default sort is the busiest first, with
`bucket` time oldest first. Every identifier in the SQL comes from the kind's table
([`src/lib/kinds.ts`](src/lib/kinds.ts)); every value is a query parameter.

| Question                               | Call                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| Errors that mention a timeout, 2 hours | `/events?level=error&q=timeout&since=2h`                          |
| One request, every hop in time order   | `/events?agcid=0193a1f0...&order=asc&since=30d`                   |
| Reliability per route, a day           | `/stats?kind=http&by=extension,part,route&since=24h`              |
| Worst availability first               | `/stats?kind=http&by=extension,route&sort=availability&order=asc` |
| Responses of one extension by status   | `/stats?kind=http&by=status&extension=market`                     |
| Errors grouped by type, newest first   | `/stats?kind=error&by=type,extension&sort=lastSeen`               |
| Containers of one machine              | `/stats?kind=container&host=next-1&by=name`                       |
| Cpu of each machine in 5 minute steps  | `/stats?kind=host&by=host&bucket=5m&since=6h`                     |
| Availability of one extension per hour | `/stats?kind=http&extension=probe&bucket=1h&since=24h`            |
| Requests and tool calls as one number  | `/stats?kind=http,mcp&by=extension&since=24h`                     |
| Rows per kind                          | `/stats?kind=any&by=kind`                                         |
| Share under 300 ms per route, worst    | `/stats?kind=http&by=route&under=300&sort=under&order=asc`        |
| Traffic by type                        | `/stats?kind=http&by=user_type`                                   |
| Errors by fingerprint                  | `/stats?kind=error&by=fingerprint`                                |
| Backup runs per day                    | `/stats?kind=event&name=backup.run&bucket=1d&since=14d`           |
| The slowest failed requests            | `/events?kind=http&ok=false&sort=ms`                              |

## Scopes

Any account can mint `logs:read` and `logs:write` for itself, so neither opens a read; only an
admin mints `logs:admin` or a service subject (`svc_`).

| Call                    | Needs                                   | Else                                            |
| ----------------------- | --------------------------------------- | ----------------------------------------------- |
| `POST /events`          | `logs:write` and a `svc_` token subject | 403 `FORBIDDEN` "ingest needs a service token"  |
| `GET /events`, `/stats` | `logs:admin`                            | 403, `WWW-Authenticate: ... scope="logs:admin"` |
| every `logs__*` tool    | `logs:admin`                            | 403                                             |

## Run

Needs Node 22+, npm 10+, Docker, `git` and `jq`.

The store tests (`src/**/*.clickhouse.test.ts`, `src/api/clickhouse.test.ts`) run against a real
ClickHouse 26.8 and skip without `CLICKHOUSE_URL`, as `ci.yml` sets it; start one first.

```bash
docker run -d --name logs-store -p 8123:8123 -e CLICKHOUSE_USER=logs -e CLICKHOUSE_DB=logs \
  -e CLICKHOUSE_PASSWORD=local clickhouse/clickhouse-server:26.8   # the estate's user, never default
npm ci
CLICKHOUSE_URL=http://logs:local@localhost:8123/logs npm run verify   # type-check, lint, format, tests, build
npx agentage extension check             # PASS logs {version} conforms
```

`up` runs no ClickHouse and mounts only declared secrets, while the estate refuses a declared
`store-url`. So a local run uses the ClickHouse above and declares `store-url` for that run only,
as `ci.yml` does; never commit that line. `172.17.0.1` is the docker host as the parts see it.

```bash
jq '.agentage.secrets = ["store-url"]' package.json > p.json && mv p.json package.json
AGENTAGE_SECRET_STORE_URL=http://logs:local@172.17.0.1:8123/logs npx agentage extension up
git checkout package.json                # after up: the images are built
npx agentage extension down              # when done; one working copy holds 4280 and 4281 at a time
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
A row is red, its reason in the state cell, by: `events` level error; `hosts` the widget's rule
(a sample older than 3 min, cpu > 80, mem > 85 or disk > 80); `services` (edge rows left out)
availability under 99.0 % (a dash under 50 requests) or the worst route's p95 over 1000 ms.
The seed posts to `localhost` or `127.0.0.1` only.
`npx playwright install chromium` once, then `npm run test:e2e` runs the widget spec (states, the
red rule, axe WCAG A/AA) against `up`.

## License

MIT
