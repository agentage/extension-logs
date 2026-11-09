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
| ui     | [`src/ui`](src/ui/index.ts)         | `/ui/{version}/logs.js`, `harness.html`                                 |

## Run

Needs Node 22+, npm 10+, Docker, `git` and `jq`.

```bash
npm ci && npm run verify                 # type-check, lint, format, tests, build
npx agentage extension check             # PASS logs {version} conforms
npx agentage extension up                # the part images behind a local gateway on 4280
```

## License

MIT
