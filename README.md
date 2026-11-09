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

## Run

Needs Node 22+, npm 10+, Docker, `git` and `jq`.

```bash
npm ci && npm run verify                 # type-check, lint, format, tests, build
npx agentage extension check             # PASS logs {version} conforms
npx agentage extension up                # the part images behind a local gateway on 4280
```

## Widgets in the harness

The ui part serves the widget kit's harness page under `up`; the seed posts 100 mixed lines
(http, mcp, error, log, span, event, one agcid with every kind), 5 `host.stats` samples (one red,
cpu 92) with their containers, and the services rows (one red by availability, one by p95).

```bash
npx agentage extension up                # needs a ClickHouse for store-url, see ci.yml
npm run harness:seed                     # LOGS_URL and LOGS_ISSUER override 4280 and 4281
open "http://localhost:4280/ui/$(jq -r .version package.json)/harness.html?widget=events&scope=logs:admin"
```

`?widget=events|hosts|services` picks one widget, `?scope=logs:admin` makes the dev issuer mint
the admin token the reads need, `?q=` prefills the events search, `?theme=light|dark` the theme.
A row is red by: `events` level error; `hosts` a sample older than 3 min, cpu > 80, mem > 85 or
disk > 80; `services` availability under 99.0 % (a dash under 50 requests) or p95 over 1000 ms.
`npm run test:e2e` runs the widget spec (states, the red rule, axe WCAG A/AA) against `up`.

## License

MIT
