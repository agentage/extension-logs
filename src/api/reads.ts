import { z } from 'zod';
import { fail, reply, type ApiContext, type Caller } from '@agentage/extension';
import * as O from '../lib/outputs.schema.js';
import * as R from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

interface Req {
  input: never;
  params: Record<string, string>;
  caller: Caller;
}
const insufficient = { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="logs:read"' };

// The kit ranks write above read; a shipper's logs:write token must not read the rows back.
const reader = ({ scopes }: Caller) => {
  if (!scopes.includes('logs:read') && !scopes.includes('logs:admin'))
    throw fail('FORBIDDEN', 'Needs logs:read', { headers: insufficient });
};

const page = async (store: EventsStore, input: R.Search) => {
  const { events, nextCursor } = await R.search(store, input);
  return reply(events, {
    meta: { pagination: { limit: input.limit, ...(nextCursor && { nextCursor }) } },
  });
};

const agcid = z.object({ agcid: R.Agcid });
const host = z.object({ host: z.string().min(1).max(253) });
const READS = [
  {
    path: '/events',
    summary: 'Search events',
    scope: 'read',
    input: R.SearchSchema,
    output: z.array(O.EventOutSchema),
    run: (s: EventsStore, r: Req) => page(s, r.input),
  },
  {
    path: '/traces/{agcid}',
    summary: 'Trace one agcid',
    scope: 'read',
    params: agcid,
    output: O.TraceOutSchema,
    run: (s: EventsStore, r: Req) => R.trace(s, r.params['agcid'] ?? ''),
  },
  {
    path: '/stats',
    summary: 'Calls, errors, availability, latency',
    scope: 'admin',
    input: R.StatsSchema,
    output: z.array(O.StatOutSchema),
    run: (s: EventsStore, r: Req) => R.stats(s, r.input),
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
    route(
      'get',
      path,
      spec as never,
      ((req: Req) => {
        if (spec.scope === 'read') reader(req.caller);
        return run(store, req);
      }) as never
    );
};
