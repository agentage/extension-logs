# extension-logs

The logs extension of agentage. Services and extensions send it one JSON line for each unit of work, such
as a request, a tool call, a job or an error. Operators and AI clients search those lines and read
counts through an API, two MCP tools and three widgets. The store is one ClickHouse table, `events`.

Words:

- **estate**: the set of servers and extensions agentage runs. The `agentage/estate` repo describes it.
- **telemetry line**: one JSON line for one unit of work. Its `kind` says what unit: `http`, `mcp`, `job`, `span`, `error`, `event` or `log`. A read also takes the kinds `host` and `container`: the samples of a machine and of a container.
- **agcid**: the id of one request. Every hop of the request logs the same `agcid`, so one search shows the whole path.
- **subject** (`sub`): the account or service that made a call. A `svc_` subject is a service.

## Quick start

You need Node 22+, npm 10+, Docker, git and `jq`. Ports 4280 and 4281 must be free. The repo needs one commit.

```bash
npm ci
npx agentage extension up --docker    # builds the images, starts ClickHouse, a dev token issuer and a gateway
T=$(npx agentage extension token --scope logs:admin)
curl -H "Authorization: Bearer $T" "localhost:4280/api/logs/events?limit=5"
npx agentage extension down
```

A new store is empty. To send lines and see the widgets, use the harness seed in
[docs/run-locally.md](docs/run-locally.md#widgets).

## What it serves

A part is one unit of the extension. The `api`, `mcp`, `worker` and `ui` parts are folders in `src/` and ship as images; `store` is the ClickHouse database.

| Part   | Source                              | Serves                                                      |
| ------ | ----------------------------------- | ----------------------------------------------------------- |
| api    | [`src/api`](src/api/index.ts)       | `/api/logs/events`, `/stats`, `openapi.json`                |
| mcp    | [`src/mcp`](src/mcp/index.ts)       | `POST /mcp`: `logs__*` ([`logs.mcpc.json`](logs.mcpc.json)) |
| worker | [`src/worker`](src/worker/index.ts) | job `retention`, nightly                                    |
| ui     | [`src/ui`](src/ui/index.ts)         | the widgets `events`, `hosts`, `services`                   |
| store  | `clickhouse` (manifest kind)        | one `events` table, [`src/lib/ddl.ts`](src/lib/ddl.ts)      |

Generated contracts:
[openapi.json](openapi.json) for the api and [logs.mcpc.json](logs.mcpc.json) for the tools.

More: [docs/api.md](docs/api.md#store-connection)

### Scopes

Any account can get a `logs:read` or `logs:write` token, so reads need `logs:admin`. Only an admin
can get `logs:admin` or a service token (`svc_`).

| Call                    | Needs                                   | Else                                            |
| ----------------------- | --------------------------------------- | ----------------------------------------------- |
| `POST /events`          | `logs:write` and a `svc_` token subject | 403 `FORBIDDEN` "ingest needs a service token"  |
| `GET /events`, `/stats` | `logs:admin`                            | 403, `WWW-Authenticate: ... scope="logs:admin"` |
| every `logs__*` tool    | `logs:admin`                            | 403                                             |

`agentage extension token` sets no subject, so its token gets 403 on `POST /events`. Without a token
a call answers 401.

### Ingest

- `POST /api/logs/events` takes a bare JSON array of lines, not an object.
- It answers `{ "success": true, "data": { "accepted": 2, "rejected": 0 } }`. A line that fails the schema or the ingest rules counts as `rejected`.
- The rules: `ts` is at most 30 days old and at most one hour ahead; `sub` is an opaque id, never an email.
- One batch holds at most 1000 lines and 1 MB.
- A retry is safe: the same batch is not stored twice within the next 1000 inserts.
- A failed insert answers 503 `UNAVAILABLE` or 500, never a count.
- Rows live 30 days. The worker only checks this; it never deletes.

More: [docs/api.md](docs/api.md#ingest)

### The two reads

`GET /api/logs/events` (tool `logs__query`) answers rows. `GET /api/logs/stats` (tool
`logs__aggregate`) answers groups, and requires `kind`. Both take filters such as `since`, `until`,
`extension`, `part`, `level`, `status`, `agcid`, `apphost` (an app host name) and `q` (text in `msg`, or an agcid).

| Question                               | Call                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| Errors that mention a timeout, 2 hours | `/events?level=error&q=timeout&since=2h`                          |
| Every line of one app host             | `/events?apphost=stub&since=15m`                                  |
| One request, every hop in time order   | `/events?agcid=<agcid>&order=asc&since=30d`                       |
| Reliability per route, a day           | `/stats?kind=http&by=extension,part,route&since=24h`              |
| Worst availability first               | `/stats?kind=http&by=extension,route&sort=availability&order=asc` |
| Cpu of each machine in 5 minute steps  | `/stats?kind=host&by=host&bucket=5m&since=6h`                     |

More: [docs/api.md](docs/api.md#reads)

## Verify

```bash
npm run verify                  # type-check, lint, format, tests, build
npx agentage extension check    # PASS logs <version> conforms
```

The store tests (`src/**/*.clickhouse.test.ts`, `src/api/clickhouse.test.ts`) need a real ClickHouse
26.8. They skip when `CLICKHOUSE_URL` is not set. To run them, start ClickHouse first:

```bash
docker run -d --name logs-store -p 8123:8123 -e CLICKHOUSE_USER=logs -e CLICKHOUSE_DB=logs \
  -e CLICKHOUSE_PASSWORD=local clickhouse/clickhouse-server:26.8   # the user is `logs`, never `default`
CLICKHOUSE_URL=http://logs:local@localhost:8123/logs npm run verify
```

CI also runs `up --docker` and the e2e gate: [docs/run-locally.md](docs/run-locally.md#what-ci-runs).

## Release

1. Set the version in `package.json`.
2. Run `npx agentage extension check --write`.
3. Merge to master.
4. Push the tag `v<version>` on master.

`release.yml` runs `npm ci --ignore-scripts`, `npm run verify`, then `agentage extension release` of the cli the lockfile pins. It refuses the id `template`, a commit off
master and a tag that is not the version. It pushes the part images to
`ghcr.io/agentage/logs-{part}` and attaches `agentage-container.json` and
`agentage-extension.json` to the GitHub release. The package is `private`: no npm.

## Deploy

A release deploys nothing. The `logs` row in `platform/installation.json` of agentage/apphosts
names the version that runs on the platform app host of `next`, the staging estate. The app host
serves `/api/logs/...` and `/mcp/logs`. The older deployment, the `logs` row in agentage/estate
`estate.yaml`, still runs at `logs.next.agentage.io`. More: [CLAUDE.md](CLAUDE.md#after-a-release).

## Documentation

- [docs/run-locally.md](docs/run-locally.md): the full run with `up` and the widget harness.
- [docs/api.md](docs/api.md): connection, `/health`, ingest, limits, retention, reads.
- [CLAUDE.md](CLAUDE.md): the rules for an agent that changes this repo.

## License

MIT, see [LICENSE](LICENSE).
