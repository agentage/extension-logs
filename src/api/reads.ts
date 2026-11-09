import { z } from 'zod';
import { fail, reply, type ApiContext, type Caller } from '@agentage/extension';
import * as O from '../lib/outputs.schema.js';
import {
  Agcid,
  SearchSchema,
  StatsSchema,
  containers,
  hosts,
  search,
  stats,
  trace,
} from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

// The kit ranks write above read; a shipper's logs:write token must not read the rows back.
const reader = (caller: Caller) => {
  if (!caller.scopes.some((scope) => scope === 'logs:read' || scope === 'logs:admin'))
    throw fail('FORBIDDEN', 'Needs logs:read');
};

export const reads = (route: ApiContext['route'], store: EventsStore) => {
  const events = z.array(O.EventOutSchema);
  route(
    'get',
    '/events',
    { summary: 'Search events', input: SearchSchema, output: events },
    async (req) => {
      reader(req.caller);
      const { events: rows, nextCursor } = await search(store, req.input);
      return reply(rows, {
        meta: { pagination: { limit: req.input.limit, ...(nextCursor && { nextCursor }) } },
      });
    }
  );
  const agcid = z.object({ agcid: Agcid });
  route(
    'get',
    '/traces/{agcid}',
    { summary: 'Trace one agcid', params: agcid, output: O.TraceOutSchema },
    (req) => {
      reader(req.caller);
      return trace(store, req.params.agcid);
    }
  );
  const statsOut = z.array(O.StatOutSchema);
  route(
    'get',
    '/stats',
    {
      summary: 'Calls, errors, availability, latency',
      scope: 'admin',
      input: StatsSchema,
      output: statsOut,
    },
    (req) => stats(store, req.input)
  );
  route(
    'get',
    '/hosts',
    { summary: 'The last sample per host', scope: 'admin', output: z.array(O.HostOutSchema) },
    () => hosts(store)
  );
  const host = z.object({ host: z.string().min(1).max(253) });
  const containersOut = z.array(O.ContainerOutSchema);
  route(
    'get',
    '/hosts/{host}/containers',
    { summary: 'The containers of one host', scope: 'admin', params: host, output: containersOut },
    (req) => containers(store, req.params.host)
  );
};
