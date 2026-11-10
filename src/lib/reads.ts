import { z } from 'zod';
import { KINDS, LEVELS } from '@agentage/extension/logs';
import * as SQL from './reads.sql.js';
import { type EventsStore, type Row } from './store.js';

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/;
const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
const iso = (ts: unknown) => `${String(ts).replace(' ', 'T')}Z`;
const back = (s: string) => Number(s.slice(0, -1)) * UNIT[s.at(-1) as keyof typeof UNIT];

// 15m, 2h, 7d back from now, or an ISO time; ClickHouse reads it as DateTime64(3, 'UTC').
const Since = z.union([
  z
    .string()
    .regex(/^\d{1,4}[mhd]$/)
    .transform((s) => stamp(new Date(Date.now() - back(s)))),
  z.iso.datetime({ offset: true }).transform((s) => stamp(new Date(s))),
]);
const decode = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    return null;
  }
};
// base64url of [ts, id] of the last row; anything else is a 400.
const Cursor = z
  .string()
  .max(200)
  .transform(decode)
  .pipe(z.tuple([z.string().regex(STAMP), z.uuid()]));
const cursorOf = (row: Row) =>
  Buffer.from(JSON.stringify([row['ts'], row['id']])).toString('base64url');

const name = z.string().min(1).max(64);
export const Agcid = z.string().regex(/^[0-9a-f]{32}$/);
// A hostname: no slash, no '..', so a path segment never reads as another route.
export const Host = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,252}$/);
export const SearchSchema = z.object({
  ...{ q: z.string().min(1).max(200).optional(), level: z.enum(LEVELS).optional() },
  ...{ extension: name.optional(), part: name.optional(), kind: z.enum(KINDS).optional() },
  ...{ agcid: Agcid.optional(), host: Host.optional() },
  ...{ since: Since.prefault('24h'), until: Since.optional(), cursor: Cursor.optional() },
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Search = z.output<typeof SearchSchema>;
export const TRUNCATED =
  'truncated: more than 200 routes in a part or 1000 in all; narrow by extension';
// The route's query: an empty window is a mistake, not an empty page.
export const SearchQuery = SearchSchema.refine(
  ({ since, until }) => until === undefined || since < until,
  { message: 'since must be before until', path: ['since'] }
);
export const StatsSchema = z.object({
  window: z.enum(['15m', '1h', '24h']).default('1h'),
  extension: name.optional(),
});
export const ErrorsSchema = z.object({ since: Since.prefault('24h'), extension: name.optional() });
type Stats = z.output<typeof StatsSchema>;
type Errors = z.output<typeof ErrorsSchema>;

const toEvent = ({ user_type, ts, ...row }: Row): Row => ({
  ...row,
  ts: iso(ts),
  userType: user_type,
});

// Newest first; one extra row says a next page exists.
export const search = async (store: EventsStore, { cursor, limit, ...filters }: Search) => {
  const at = cursor && { cursorTs: cursor[0], cursorId: cursor[1] };
  const params: Row = { ...filters, ...at, limit: limit + 1 };
  const where = Object.entries(SQL.FILTERS).filter(([key]) => params[key] !== undefined);
  const rows = await store.query(SQL.SEARCH(where.map(([, sql]) => sql).join(' AND ')), params);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return { events: rows.slice(0, limit).map(toEvent), nextCursor: last && cursorOf(last) };
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
