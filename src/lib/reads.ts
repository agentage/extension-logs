import { z } from 'zod';
import { EventsCursor, checkSearch, cursorOf, eventsName } from './events-cursor.js';
import { FILTER_FIELDS, Order, Since, iso } from './filters.schema.js';
import { GROUP_FIELDS, checkGroups } from './groups.schema.js';
import { GROUP_KINDS, KIND_DEFS } from './kinds.js';
import * as SQL from './reads.sql.js';
import { type EventsStore, type Row } from './store.js';

export const SearchSchema = z.object({
  ...FILTER_FIELDS,
  ...{ kind: z.enum(GROUP_KINDS).optional(), order: Order.default('desc') },
  sort: z.enum(['ts', 'ms']).default('ts'),
  ...{ since: Since.prefault('24h'), until: Since.optional(), cursor: EventsCursor.optional() },
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});
export type Search = z.output<typeof SearchSchema>;
export { checkSearch };
// The route's query: an empty window is a mistake, not an empty page.
export const SearchQuery = SearchSchema.refine(
  ({ since, until }) => until === undefined || since < until,
  { message: 'since must be before until', path: ['since'] }
).superRefine(checkSearch);
// GET /stats: window was the 0.2 form; a 400 says use since, never silently ignored.
export const StatsQuery = z
  .object({
    ...GROUP_FIELDS,
    window: z.never({ error: 'window is the 0.2 form: use since' }).optional(),
  })
  .superRefine(checkGroups);

const toEvent = ({ user_type, ts, ...row }: Row): Row => ({
  ...row,
  ts: iso(ts),
  userType: user_type,
});

// The builder trusts no caller: a name filter on a kind without names never becomes SQL.
const nameOf = (kind?: Search['kind']) => {
  const sql = eventsName(kind);
  if (!sql) throw new Error('search: a name filter on a kind without names');
  return sql;
};
const whereOf = ({ kind, cursor, name, order = 'desc', sort = 'ts' }: Search, params: Row) => [
  ...Object.entries(SQL.FILTERS)
    .filter(([key]) => params[key] !== undefined)
    .map(([, sql]) => sql),
  ...(name !== undefined ? [nameOf(kind)] : []),
  ...(kind ? [KIND_DEFS[kind].where] : []),
  ...(cursor ? [SQL.AFTER(sort, order)] : []),
];

// Newest first (or oldest first, or by ms); one extra row says a next page exists.
export const search = async (store: EventsStore, input: Search) => {
  const { cursor, limit, order = 'desc', sort = 'ts', ...filters } = input;
  const at = cursor && { cursorTs: cursor.t, cursorId: cursor.i, cursorMs: cursor.m };
  const params: Row = { ...filters, ...at, limit: limit + 1 };
  const where = whereOf(input, params).join(' AND ');
  const rows = await store.query(SQL.SEARCH(where, order, sort), params);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  const nextCursor = last && cursorOf(last, input);
  return { events: rows.slice(0, limit).map(toEvent), nextCursor };
};
