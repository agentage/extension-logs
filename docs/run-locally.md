# Run it locally

## Run the whole extension with `up`

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
