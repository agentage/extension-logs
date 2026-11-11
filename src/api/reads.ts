import { z } from 'zod';
import { reply, type ApiContext } from '@agentage/extension';
import { groups } from '../lib/groups.js';
import { type GroupsInput } from '../lib/groups.schema.js';
import * as O from '../lib/outputs.schema.js';
import * as R from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

interface Req {
  input: never;
}

const page = async (store: EventsStore, input: R.Search) => {
  const { events, nextCursor } = await R.search(store, input);
  return reply(events, {
    meta: { pagination: { limit: input.limit, ...(nextCursor && { nextCursor }) } },
  });
};

const stats = async (store: EventsStore, input: GroupsInput) => {
  const { groups: rows, meta } = await groups(store, input);
  return reply(rows, { meta });
};

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
    path: '/stats',
    summary: 'Groups of one kind with its measures (kind, by, bucket, sort, cursor)',
    scope: 'admin',
    input: R.StatsQuery,
    output: z.array(O.GroupOutSchema),
    run: (s: EventsStore, r: Req) => stats(s, r.input),
  },
] as const;

export const reads = (route: ApiContext['route'], store: EventsStore) => {
  for (const { run, path, ...spec } of READS)
    route('get', path, spec as never, ((req: Req) => run(store, req)) as never);
};
