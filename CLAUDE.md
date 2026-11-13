# CLAUDE.md - agentage/extension-logs

The logs extension of agentage (public repo; the npm package is `private`). The human guide is
[README.md](README.md): words, local run, API rules, release; depth in `docs/`. The kit rules are
in the README of [`@agentage/extension`](https://www.npmjs.com/package/@agentage/extension);
the shape of an extension is [agentage/extension-probe](https://github.com/agentage/extension-probe).
This file only adds what the tree does not say.

## Where facts live

- Routes, scopes, status codes: `openapi.json` (generated; never edit by hand).
- MCP tools and their inputs: `logs.mcpc.json` (generated).
- Which scope each call needs: `README.md` "Scopes".
- Ingest body, size limits and the store's limits: `docs/api.md` "Ingest" and "The store's limits".
- Filters, `kind` and the stats groups: `docs/api.md` "Reads".
- Run it locally, ClickHouse for the store tests: `README.md` "Run it locally"; `up` and the widget harness: `docs/run-locally.md`.
- The events table (there is no `migrations/`): `src/lib/ddl.ts`.
- CI jobs and the gate floor (`MIN_EXECUTED`): `.github/workflows/ci.yml`.
- Release rules and refusals: `.github/workflows/release.yml`, steps in `README.md` "Release".

Read the file named here before you read `src/`.

## Rules

- A part module exports `create(ctx)` only; `src/ui/index.ts` exports `widgets` only. Never
  `listen()`, the `process` global (or an import of it), an absolute agentage URL, a symlink or a dependency on another extension in `src/`. The kit checks the token: a part needs none.
- A part imports only its own folder and `src/lib/` (`src/manifest.test.ts` refuses a crossing).
- `openapi.json` and `logs.mcpc.json` are committed contracts: after a route or tool change run
  `npm run build`, `npx agentage extension check --write`, then `npm run format`.
- Release: steps in the README. Never move a `v*` tag. `agentage extension release` refuses the
  starting-point id, a commit off master and a tag that is not the version
  (`.github/workflows/release.yml`).
- The store connection is the file the estate mounts, `/run/secrets/store-url`
  (`src/lib/connection.ts`); never commit `store-url` in `agentage.secrets` (the estate refuses it). The local run in `docs/run-locally.md` adds it for one run and undoes it.

## Commands

- `npm run verify`; `npx agentage extension up` then `npm run test:e2e`; `npx agentage extension down`.
