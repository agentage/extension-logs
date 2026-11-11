import { type McpContext } from '@agentage/extension';
import { openStore } from '../lib/open-store.js';
import { READ_TOOLS } from './reads.js';

// The two reads; each needs logs:admin.
export function create({ tool, log }: McpContext) {
  const { store } = openStore(log);
  for (const { name, run, ...spec } of READ_TOOLS)
    tool(name, { ...spec, scope: 'admin' } as never, ((args: never) => run(store, args)) as never);
}
