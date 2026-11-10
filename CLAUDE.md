# CLAUDE.md - agentage/extension-logs

Public repo. The logs extension of the agentage platform. Standards: the engineering standards
batch (repo-baseline, typescript, code-style, testing, ci-cd, backend, security); the kit rules are
in the README of [`@agentage/extension`](https://www.npmjs.com/package/@agentage/extension);
the shape of an extension is [agentage/extension-probe](https://github.com/agentage/extension-probe).
This file only adds what the tree does not say.

## Rules

- A part module exports `create(ctx)` only; `src/ui/index.ts` exports `widgets` only. Never
  `listen()`, the `process` global, a token check or an absolute agentage URL in `src/`.
- A part imports only its own folder and `src/lib/` (`src/manifest.test.ts` refuses a crossing).
- `openapi.json` and `logs.mcpc.json` are committed contracts: after a route or tool change run
  `npm run build`, `npx agentage extension check --write`, then `npm run format`.
- Release: bump `package.json`, `check --write`, commit, push the tag `v{version}` on master;
  `release.yml` pushes the images and attaches the record (the package is private: no npm).
  Never move a `v*` tag.
- The store connection is the file the estate mounts, `/run/secrets/store-url`
  (`src/lib/connection.ts`); never declare `store-url` in `agentage.secrets` (the estate refuses it).

## Commands

- `npm run verify`; `npx agentage extension up` then `npm run test:e2e`; `npx agentage extension down`.
