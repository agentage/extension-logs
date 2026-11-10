import { z } from 'zod';
import { EventsCursor, checkSearch, cursorOf, eventsName } from './events-cursor.js';
import { Agcid, FILTER_FIELDS, Host, Order, Since, iso } from './filters.schema.js';
import { GROUP_FIELDS, checkGroups } from './groups.schema.js';
import { GROUP_KINDS, KIND_DEFS } from './kinds.js';
import * as SQL from './reads.sql.js';
import { type EventsStore, type Row } from './store.js';

export { Agcid, Host };
export const SearchSchema = z.object({
  ...FILTER_FIELDS,
  ...{ kind: z.enum(GROUP_KINDS).optional(), order: Order.default('desc') },
  sort: z.enum(['ts', 'ms']).default('ts'),
  ...{ since: Since.prefault('24h'), until: Since.optional(), cursor: EventsCursor.optional() },
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});
export type Search = z.output<typeof SearchSchema>;
export const TRUNCATED =
  'truncated: more than 200 routes in a part or 1000 in all; narrow by extension';
export { checkSearch };
// The route's query: an empty window is a mistake, not an empty page.
export const SearchQuery = SearchSchema.refine(
  ({ since, until }) => until === undefined || since < until,
  { message: 'since must be before until', path: ['since'] }
).superRefine(checkSearch);
export const StatsSchema = z.object({
  window: z.enum(['15m', '1h', '24h']).default('1h'),
  extension: FILTER_FIELDS.extension,
});
// GET /stats: with kind the groups read, without it today's answer (window, extension).
// window belongs to the 0.2 form: with kind it is a 400, never silently ignored.
export const StatsQuery = z
  .object({
    ...{ ...GROUP_FIELDS, extension: StatsSchema.shape.extension },
    ...{ window: StatsSchema.shape.window.unwrap().optional(), kind: GROUP_FIELDS.kind.optional() },
  })
  .superRefine((input, ctx) => {
    if (input.kind && input.window)
      ctx.addIssue({
        code: 'custom',
        path: ['window'],
        message: 'window is the form without kind: use since',
      });
    checkGroups(input, ctx);
  });
export const ErrorsSchema = z.object({
  since: Since.prefault('24h'),
  extension: FILTER_FIELDS.extension,
});
export type Stats = z.output<typeof StatsSchema>;
type Errors = z.output<typeof ErrorsSchema>;

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
  // logs__search has no order and no sort: newest first.
  const { cursor, limit, order = 'desc', sort = 'ts', ...filters } = input;
  const at = cursor && { cursorTs: cursor.t, cursorId: cursor.i, cursorMs: cursor.m };
  const params: Row = { ...filters, ...at, limit: limit + 1 };
  const where = whereOf(input, params).join(' AND ');
  const rows = await store.query(SQL.SEARCH(where, order, sort), params);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  const nextCursor = last && cursorOf(last, input);
  return { events: rows.slice(0, limit).map(toEvent), nextCursor };
};

// Every event of one agcid in time order; hops = the request rows (http, mcp).
export const trace = async (store: EventsStore, agcid: string) => {
  const rows = await store.query(SQL.TRACE, { agcid });
  const at = rows.map((row) => Date.parse(iso(row['ts'])));
  const start = Math.min(...rows.map((row, i) => (at[i] ?? 0) - Number(row['ms'])));
  const hops = rows.filter((row) => row['kind'] === 'http' || row['kind'] === 'mcp').length;
  const ms = rows.length > 0 ? Math.max(...at) - start : 0;
  return { agcid, hops, ms, ok: rows.every((row) => row['ok']), events: rows.map(toEvent) };
};

const onExtension = (extension?: string) =>
  extension ? ' AND extension = {extension:String}' : '';

// At most 200 rows per part and 1000 in all; truncated says a row was left out.
const capped = (rows: Row[]) => {
  const seen = new Map<string, number>();
  const kept = rows.filter((row) => {
    const key = `${String(row['extension'])}/${String(row['part'])}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    return (seen.get(key) ?? 0) <= SQL.STATS_PER_PART;
  });
  return {
    kept: kept.slice(0, SQL.STATS_MAX),
    truncated: kept.length < rows.length || kept.length > SQL.STATS_MAX,
  };
};

export const stats = async (store: EventsStore, { window, extension }: Stats) => {
  const params = { since: Since.parse(window), extension };
  const { kept, truncated } = capped(await store.query(SQL.STATS(onExtension(extension)), params));
  const rows = kept.map(({ q, ...row }): Row => {
    const [p50 = 0, p95 = 0, p99 = 0] = q as number[];
    return { ...row, p50, p95, p99 };
  });
  return { stats: rows, truncated };
};

export const hosts = async (store: EventsStore) =>
  (await store.query(SQL.HOSTS)).map((row): Row => ({
    ...row,
    at: iso(row['at']),
    red: Boolean(row['red']),
  }));

export const containers = (store: EventsStore, host: string) =>
  store.query(SQL.CONTAINERS, { host });

export const errors = async (store: EventsStore, { since, extension }: Errors) =>
  (await store.query(SQL.ERRORS(onExtension(extension)), { since, extension })).map(
    ({ sample, ...row }): Row => ({ ...row, msg: sample, lastSeen: iso(row['lastSeen']) })
  );
