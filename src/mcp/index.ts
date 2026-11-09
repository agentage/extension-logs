import { z } from 'zod';
import { type McpContext } from '@agentage/extension';
import '../lib/secrets.types.js';
import * as O from '../lib/outputs.schema.js';
import * as R from '../lib/reads.js';
import { clickhouse, createEventsStore } from '../lib/store.js';

const SearchInput = R.SearchSchema.pick({
  q: true,
  level: true,
  extension: true,
  kind: true,
  since: true,
}).extend({ limit: z.int().min(1).max(200).default(20) });
const HostsInput = z.object({ host: z.string().min(1).max(253).optional() });

// Five tools on the api's SQL; every one needs logs:admin.
export function create({ tool, secrets, log }: McpContext) {
  const store = createEventsStore(clickhouse(secrets.storeUrl), log);
  const admin = 'admin' as const;
  tool(
    'search',
    {
      description:
        'Search logged events, newest first: text in msg or an agcid, level, extension, kind, since (15m, 2h, 7d).',
      scope: admin,
      input: SearchInput,
      output: z.object({ events: z.array(O.EventOutSchema) }),
    },
    async (args) => ({ events: (await R.search(store, args)).events })
  );
  tool(
    'trace',
    {
      description: 'Every event of one agcid (32 hex) in time order, with hops, ms and ok.',
      scope: admin,
      input: z.object({ agcid: R.Agcid }),
      output: O.TraceOutSchema,
    },
    ({ agcid }) => R.trace(store, agcid)
  );
  tool(
    'errors',
    {
      description: 'Errors grouped by exception type and message: count, last seen, one agcid.',
      scope: admin,
      input: R.ErrorsSchema,
      output: z.object({ errors: z.array(O.ErrorOutSchema) }),
    },
    async (args) => ({ errors: await R.errors(store, args) })
  );
  tool(
    'stats',
    {
      description:
        'Per extension, part, route and tool: calls, errors, availability, p50, p95, p99, users.',
      scope: admin,
      input: R.StatsSchema,
      output: z.object({ stats: z.array(O.StatOutSchema) }),
    },
    async (args) => ({ stats: await R.stats(store, args) })
  );
  tool(
    'hosts',
    {
      description:
        "The last sample per host (cpu, mem, disk, load1, containers, red), or one host's containers.",
      scope: admin,
      input: HostsInput,
      output: z.object({
        hosts: z.array(O.HostOutSchema).optional(),
        containers: z.array(O.ContainerOutSchema).optional(),
      }),
    },
    async ({ host }) =>
      host ? { containers: await R.containers(store, host) } : { hosts: await R.hosts(store) }
  );
}
