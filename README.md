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

## Parts

| Part   | Source                              | Serves                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/v1/events`, `/stats`, `openapi.json`                  |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json)) |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                    |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                   |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)      |

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

## Release

1. Set the version in `package.json`.
2. Run `npx agentage extension check --write`.
3. Merge to master.
4. Push the tag `v<version>` on master.

`release.yml` runs `agentage extension release`. It refuses the starting-point id, a commit off
master and a tag that is not the version. It keeps a released version. It pushes the part images to
`ghcr.io/agentage/logs-{part}` and attaches `agentage-extension.json` (the images by digest) to the
GitHub release. The estate pins those. The package is `private`: no npm publish.

## License

MIT
