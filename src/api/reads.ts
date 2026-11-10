import { z } from 'zod';
import { reply, type ApiContext } from '@agentage/extension';
import { groups } from '../lib/groups.js';
import { type GroupsInput } from '../lib/groups.schema.js';
import * as O from '../lib/outputs.schema.js';
import * as R from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

interface Req {
  input: never;
  params: Record<string, string>;
}

const page = async (store: EventsStore, input: R.Search) => {
  const { events, nextCursor } = await R.search(store, input);
  return reply(events, {
    meta: { pagination: { limit: input.limit, ...(nextCursor && { nextCursor }) } },
  });
};

// With kind the groups of the two-reads API; without it today's fixed answer.
const stats = async (store: EventsStore, input: z.output<typeof R.StatsQuery>) => {
  if (input.kind === undefined) {
    const { window = '1h', extension } = input;
    const { stats: rows, truncated } = await R.stats(store, { window, extension });
    return reply(rows, { meta: { truncated } });
  }
  const { groups: rows, meta } = await groups(store, input as GroupsInput);
  return reply(rows, { meta });
};

const agcid = z.object({ agcid: R.Agcid });
const host = z.object({ host: R.Host });
// Any account can mint logs:read for itself, so every read needs logs:admin.
const READS = [
  {
    path: '/events',
    summary: 'Events, newest first (order=asc for a trace): kind, filters, cursor',
    scope: 'admin',
    input: R.SearchQuery,
    output: z.array(O.EventOutSchema),
    run: (s: EventsStore, r: Req) => page(s, r.input),
  },
  {
    path: '/traces/{agcid}',
    summary: 'Trace one agcid',
    scope: 'admin',
    params: agcid,
    output: O.TraceOutSchema,
    run: (s: EventsStore, r: Req) => R.trace(s, r.params['agcid'] ?? ''),
  },
  {
    path: '/stats',
    summary:
      'Groups of one kind with its measures (kind, by, bucket, sort, cursor); without kind, the window form',
    scope: 'admin',
    input: R.StatsQuery,
    output: z.union([z.array(O.StatOutSchema), z.array(O.GroupOutSchema)]),
    run: (s: EventsStore, r: Req) => stats(s, r.input),
  },
  {
    path: '/hosts',
    summary: 'The last sample per host',
    scope: 'admin',
    output: z.array(O.HostOutSchema),
    run: (s: EventsStore) => R.hosts(s),
  },
  {
    path: '/hosts/{host}/containers',
    summary: 'The containers of one host',
    scope: 'admin',
    params: host,
    output: z.array(O.ContainerOutSchema),
    run: (s: EventsStore, r: Req) => R.containers(s, r.params['host'] ?? ''),
  },
] as const;

export const reads = (route: ApiContext['route'], store: EventsStore) => {
  for (const { run, path, ...spec } of READS)
    route('get', path, spec as never, ((req: Req) => run(store, req)) as never);
};
