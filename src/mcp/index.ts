import { z } from 'zod';
import { type McpContext } from '@agentage/extension';
import * as O from '../lib/outputs.schema.js';
import { openStore } from '../lib/open-store.js';
import * as R from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

const pick = { q: true, level: true, extension: true, kind: true, since: true } as const;
const search = R.SearchSchema.pick(pick).extend({ limit: z.int().min(1).max(200).default(20) });
const hosts = z.object({ host: z.string().min(1).max(253).optional() });
const many = <T extends z.ZodType>(row: T) => z.array(row).optional();
type Args = never;

const TOOLS = [
  {
    name: 'search',
    description:
      'Search logged events, newest first: text in msg or an agcid, level, extension, kind, since (15m, 2h, 7d).',
    input: search,
    output: z.object({ events: many(O.EventOutSchema) }),
    run: async (s: EventsStore, a: Args) => ({ events: (await R.search(s, a)).events }),
  },
  {
    name: 'trace',
    description: 'Every event of one agcid (32 hex) in time order, with hops, ms and ok.',
    input: z.object({ agcid: R.Agcid }),
    output: O.TraceOutSchema,
    run: (s: EventsStore, a: { agcid: string }) => R.trace(s, a.agcid),
  },
  {
    name: 'errors',
    description: 'Errors grouped by exception type and message: count, last seen, one agcid.',
    input: R.ErrorsSchema,
    output: z.object({ errors: many(O.ErrorOutSchema) }),
    run: async (s: EventsStore, a: Args) => ({ errors: await R.errors(s, a) }),
  },
  {
    name: 'stats',
    description:
      'Per extension, part, route and tool: calls, errors, availability, p50, p95, p99, users.',
    input: R.StatsSchema,
    output: z.object({ stats: many(O.StatOutSchema) }),
    run: async (s: EventsStore, a: Args) => ({ stats: await R.stats(s, a) }),
  },
  {
    name: 'hosts',
    description:
      "The last sample per host (cpu, mem, disk, load1, containers, red), or one host's containers.",
    input: hosts,
    output: z.object({ hosts: many(O.HostOutSchema), containers: many(O.ContainerOutSchema) }),
    run: async (s: EventsStore, { host }: { host?: string }) =>
      host ? { containers: await R.containers(s, host) } : { hosts: await R.hosts(s) },
  },
] as const;

// Five tools on the api's SQL; every one needs logs:admin.
export function create({ tool, log }: McpContext) {
  const { store } = openStore(log);
  for (const { name, run, ...spec } of TOOLS)
    tool(name, { ...spec, scope: 'admin' } as never, ((args: never) => run(store, args)) as never);
}
