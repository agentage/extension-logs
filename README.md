# extension-logs

The logs extension of agentage. Services and extensions send it one JSON line for each unit of work: a
request, a job or an error. Operators and AI clients search those lines and read counts through an API, two MCP tools
and three widgets. The store is one ClickHouse table, `events`.

Words used here:

- **estate**: the set of servers and extensions agentage runs. The `agentage/estate` repo describes it.
- **part**: one folder in `src/` (`api`, `mcp`, `worker` or `ui`). Each part ships as its own image.
- **telemetry line** (an event): one JSON line for one unit of work. Its `kind` says what unit: `http`, `mcp`, `job`, `span`, `error`, `event` or `log`.
- **agcid**: the id of one request. Every hop of the request logs the same `agcid`, so one search shows the whole path.
- **subject** (`sub`): the account or service that made a call. A `svc_` subject is a service.

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

`npx agentage extension up` alone fails: it does not start ClickHouse. To run every part, see
[docs/run-locally.md](docs/run-locally.md#run-the-whole-extension-with-up).

## Parts

| Part   | Source                              | Serves                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/v1/events`, `/stats`, `openapi.json`                  |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json)) |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                    |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                   |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)      |

The full contracts are generated:
[openapi.json](openapi.json) for the api and [logs.mcpc.json](logs.mcpc.json) for the tools.

More: [docs/api.md](docs/api.md#store-connection)

## Scopes

Any account can get a `logs:read` or `logs:write` token, so reads need `logs:admin`. Only an admin
can get `logs:admin` or a service token (`svc_`).

| Call                    | Needs                                   | Else                                            |
| ----------------------- | --------------------------------------- | ----------------------------------------------- |
| `POST /events`          | `logs:write` and a `svc_` token subject | 403 `FORBIDDEN` "ingest needs a service token"  |
| `GET /events`, `/stats` | `logs:admin`                            | 403, `WWW-Authenticate: ... scope="logs:admin"` |
| every `logs__*` tool    | `logs:admin`                            | 403                                             |

`agentage extension token` sets no subject, so its token gets 403 on `POST /events`. Without a token
a call answers 401.

## Ingest

- `POST /api/v1/events` takes a JSON array of up to 1000 lines and answers `{ accepted, rejected }`.
- Rows live 30 days. The worker only checks this; it never deletes.

More: [docs/api.md](docs/api.md#ingest)

## The two reads

`GET /api/v1/events` (tool `logs__query`) answers rows. `GET /api/v1/stats` (tool
`logs__aggregate`) answers groups, and requires `kind`. Both take filters such as `since`, `until`,
`extension`, `part`, `level`, `status`, `agcid` and `q` (text in `msg`, or an agcid).

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

More: [docs/api.md](docs/api.md#reads)

## Widgets in the harness

Under `up`, the ui part serves the widget kit's harness page. `npm run harness:seed` posts sample
lines to the api, and `npm run test:e2e` runs the widget spec.

More: [docs/run-locally.md](docs/run-locally.md#widgets)

## Release

1. Set the version in `package.json`.
2. Run `npx agentage extension check --write`.
3. Merge to master.
4. Push the tag `v<version>` on master.

`release.yml` runs `agentage extension release`. It refuses the id `template`, a commit off
master and a tag that is not the version. It keeps a released version. It pushes the part images to
`ghcr.io/agentage/logs-{part}` and attaches `agentage-extension.json` (the images by digest) to the
GitHub release. The estate pins those. The package is `private`: no npm publish.

## Documentation

- [docs/run-locally.md](docs/run-locally.md): the full run with `up` and the widget harness.
- [docs/api.md](docs/api.md): store connection, `/health`, ingest, store limits, retention, reads.

## License

MIT
