# extension-logs

The logs extension of agentage. Every part of the estate sends its telemetry lines here. Operators
and AI clients search them and read counts through an API, two MCP tools and three widgets.
To run it locally, see [Run it locally](#run-it-locally).

Words used here:

- **estate**: the set of servers and extensions agentage runs. The `agentage/estate` repo describes it.
- **kit**: `@agentage/extension`, the library that owns the servers, `/health`, auth and the scheduler.
- **telemetry line** (an event): one JSON line for one unit of work. Its `kind` says what unit: `http`, `mcp`, `job`, `span`, `error`, `event` or `log`.
- **agcid**: the id of one request. Every hop of the request logs the same `agcid`, so one search shows the whole path.
- **store kind**: the type of database a part declares in `package.json`. Here it is `clickhouse`.
- **subject** (`sub`): the account or service that made a call. A `svc_` subject is a service.

Every line lands in one ClickHouse table, `events`. The api serves ingest and two reads (rows and
groups). The mcp part serves the same reads as tools. The worker checks retention each night. The ui
part serves three widgets.

## Run it locally

You need Node 22+, npm 10+, Docker, git and `jq`. Ports 4280 and 4281 must be free.

```bash
npm ci
npm run verify                  # type-check, lint, format, tests, build
npx agentage extension check    # PASS logs <version> conforms
```

The store tests (`src/**/*.clickhouse.test.ts`, `src/api/clickhouse.test.ts`) need a real ClickHouse
26.8. They skip when `CLICKHOUSE_URL` is not set. CI sets it. To run them, start ClickHouse first:

```bash
docker run -d --name logs-store -p 8123:8123 -e CLICKHOUSE_USER=logs -e CLICKHOUSE_DB=logs \
  -e CLICKHOUSE_PASSWORD=local clickhouse/clickhouse-server:26.8   # the user is `logs`, never `default`
CLICKHOUSE_URL=http://logs:local@localhost:8123/logs npm run verify
```

### Run the whole extension with `up`

`npx agentage extension up` does not run ClickHouse. This extension needs a store kind that `up`
cannot start, so a plain `up` fails. You see this line:

```text
FAIL api /health status unavailable, needs ok or degraded
```

To run it, use the ClickHouse above and declare the `store-url` secret for this run only.
The estate refuses a declared `store-url`, so never commit the edit. `172.17.0.1` is the docker host
as the parts see it.

1. `jq '.agentage.secrets = ["store-url"]' package.json > p.json && mv p.json package.json`
2. `export AGENTAGE_SECRET_STORE_URL=http://logs:local@172.17.0.1:8123/logs`
3. `npx agentage extension up` - `up` builds the images from `HEAD`, so the repo needs one commit; the tree can be dirty.
4. `git checkout package.json` - the images are built, so undo the edit now.
5. Call it with a token that has the extension's scope: `T=$(npx agentage extension token --scope logs:admin)`, then `curl -H "Authorization: Bearer $T" "localhost:4280/api/v1/events?limit=5"`.
6. `npx agentage extension down` - one working copy holds ports 4280 and 4281 at a time.

`agentage extension token` sets no subject, so its token gets 403 on `POST /events`. Ingest needs a
`svc_` subject; the harness seed below mints one. Without a token a call answers 401.

## Parts

| Part   | Source                              | Serves                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/v1/events`, `/stats`, `openapi.json`                  |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json)) |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                    |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                   |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)      |

The line is `EventSchema` of `@agentage/extension/logs`. The ingest adds two rules: a `ts` inside the
30-day TTL, and a subject that is an opaque id `[A-Za-z0-9_-]{1,64}`, never an email.
The api, mcp and worker read the store connection from `/run/secrets/store-url` on first use. The
estate mounts that file (`http://logs:{pw}@logs_store:8123/logs`: user, password, host, database).
`/health` of the api carries two checks, each bounded at 900 ms:

- `checks.clickhouse`: a `SELECT 1`.
- `checks.disk`: the free bytes of the events table's disks, with the estate's 1 GiB reserve included.
  Under 1.5 GiB, or unreadable, is `degraded`, never `unavailable`. A full disk stops the ingest with
  503 while the reads still answer.

The full contracts are generated: [openapi.json](openapi.json) for the api and
[logs.mcpc.json](logs.mcpc.json) for the tools. The sections below state only the rules a wrong
guess would break.

## Scopes

Any account can mint `logs:read` and `logs:write` for itself, so neither opens a read; only an
admin mints `logs:admin` or a service subject (`svc_`).

| Call                    | Needs                                   | Else                                            |
| ----------------------- | --------------------------------------- | ----------------------------------------------- |
| `POST /events`          | `logs:write` and a `svc_` token subject | 403 `FORBIDDEN` "ingest needs a service token"  |
| `GET /events`, `/stats` | `logs:admin`                            | 403, `WWW-Authenticate: ... scope="logs:admin"` |
| every `logs__*` tool    | `logs:admin`                            | 403                                             |

## Ingest and the store's limits

`POST /api/v1/events` takes a bare JSON array of lines, not an object. It answers
`{ accepted, rejected }`. A line that fails the schema or the two rules counts as `rejected`.
One batch (at most 1000 lines, 1 MB) is one ClickHouse insert.

- `accepted: N` means the store has the rows. A failed insert answers 503 `UNAVAILABLE` or 500 `INTERNAL`, never a count.
- 503 means the store is down, slow past 10 s, at one of its limits or unable to write (no space, a read-only table).
- A retry is safe. The api sets `non_replicated_deduplication_window = 1000` on the table and sends each batch with a token (the sha256 of its rows). The same batch again stores nothing, even when the first attempt landed after its 503.
- Two identical batches sent on purpose count once. The window counts inserts, not time: a retry more than 1000 inserts later is stored again.
- The api runs the `ALTER` only when `SHOW CREATE TABLE events` lacks the setting.

Every read runs with `max_execution_time` 9 s, `max_memory_usage` 256 MB and `max_result_rows` 10000.
A read past a limit throws, never cuts silently. It answers 503 `UNAVAILABLE`: "The store is busy: narrow
the query or retry". The `services` widget reads `/stats` through `logs__aggregate` and shows `truncated` in its caption.

Retention: the table has a TTL of 30 days on `ts`. The worker job `retention` runs daily at 03:17 (timeout 60 s).
It only checks the oldest partition and fails when it is older than 31 days. It never deletes.

## The two reads

`GET /api/v1/events` (tool `logs__query`) answers rows. `GET /api/v1/stats` (tool `logs__aggregate`)
answers groups, and requires `kind`; without it, or with `window`, it is a 400. Both take `kind` and these filters:

- `since` and `until`: `15m`, `2h`, `7d` or an ISO time.
- `extension`, `part`, `host`, `level`, `route`, `status`, `agcid`, `sub`, `ok` (`true` or `false`).
- `name`: what `by=name` groups. It is the event name on `event`, `any` or no kind, and the container name on `container`. Another kind is a 400.
- `q`: text in `msg`, or an agcid. `/stats` also takes `user_type`.

`/events` adds:

- `order`: `desc` (newest first) or `asc`.
- `sort`: `ts`, or `ms` for the slowest first (ties by time).
- `limit`: at most 1000.
- `cursor`: bound to its query. With another kind, filter, sort or order it is a 400.

`/stats` adds:

- `by`: a comma list (below).
- `bucket`: `1m`, `5m`, `1h` or `1d`. It draws at most 1500 steps.
- `under`: ms, on `http` and `mcp`. It adds the measure `under`, the share of the group's rows at or under it.
- `sort`: a measure or a `by` name. Any other name is a 400 that lists the allowed ones.
- `order`, `limit` (100, at most 1000) and `cursor`. A group without a value sorts last.
- `meta.nextCursor` pins the window of page 1, so every page is cut from the same rows. A cursor sent with another kind, `by`, sort, order or filter is a 400.
- Page 1 ends 5 s before now (unless `until` is given), so a late row cannot move a group between pages. A call groups at most 100000 groups; past that it answers 503 busy.
- `kind` also takes `http,mcp` (one number over both) and `log,event`, in either order, and `any` (every row: count, firstSeen, lastSeen). Another list is a 400 that names the allowed ones. A list and `any` add `kind` to `by`.
- Quantiles, averages and percents answer at most 2 decimals; availability and `under` 4.

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
| One request, every hop in time order   | `/events?agcid=<agcid>&order=asc&since=30d`                       |
| Reliability per route, a day           | `/stats?kind=http&by=extension,part,route&since=24h`              |
| Worst availability first               | `/stats?kind=http&by=extension,route&sort=availability&order=asc` |
| Cpu of each machine in 5 minute steps  | `/stats?kind=host&by=host&bucket=5m&since=6h`                     |
| Share under 300 ms per route, worst    | `/stats?kind=http&by=route&under=300&sort=under&order=asc`        |
| Rows per kind                          | `/stats?kind=any&by=kind`                                         |
| Requests and tool calls as one number  | `/stats?kind=http,mcp&by=extension&since=24h`                     |

## Release

1. Set the version in `package.json`.
2. Run `npx agentage extension check --write`.
3. Merge to master.
4. Push the tag `v<version>` on master.

`release.yml` runs `agentage extension release`. It refuses the starting-point id, a commit off
master and a tag that is not the version. It keeps a released version. It pushes the part images to
`ghcr.io/agentage/logs-{part}` and attaches `agentage-extension.json` (the images by digest) to the
GitHub release. The estate pins those. The package is `private`: no npm publish.

## Widgets in the harness

The ui part serves the widget kit's harness page under `up`; the seed posts 100 mixed lines
(http, mcp, error, log, span, event, one agcid with every kind), 5 `host.stats` samples (one red,
cpu 92) with their containers, and the services rows (one red by availability, one by p95).

```bash
npx agentage extension up                # with ClickHouse and store-url, see Run it locally
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
