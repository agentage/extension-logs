import { z } from 'zod';
import { fail } from '@agentage/extension';
import { KINDS, LEVELS } from './event.schema.js';
import type * as O from './outputs.schema.js';
import * as SQL from './reads.sql.js';
import { type EventsStore } from './store.js';

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
const iso = (ts: string) => `${ts.replace(' ', 'T')}Z`;

// 15m, 2h, 7d back from now, or an ISO time; ClickHouse reads it as DateTime64(3).
export const Since = z.union([
  z
    .string()
    .regex(/^\d{1,4}[mhd]$/)
    .transform((s) => {
      const back = Number(s.slice(0, -1)) * UNIT[s.at(-1) as keyof typeof UNIT];
      return stamp(new Date(Date.now() - back));
    }),
  z.iso.datetime({ offset: true }).transform((s) => stamp(new Date(s))),
]);

const name = z.string().min(1).max(64);
export const Agcid = z.string().regex(/^[0-9a-f]{32}$/);

export const SearchSchema = z.object({
  q: z.string().min(1).max(200).optional(),
  level: z.enum(LEVELS).optional(),
  extension: name.optional(),
  part: name.optional(),
  kind: z.enum(KINDS).optional(),
  agcid: Agcid.optional(),
  host: name.optional(),
  since: Since.prefault('24h'),
  until: Since.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Search = z.output<typeof SearchSchema>;

type Out<T extends z.ZodType> = z.input<T>;
type Stored = Omit<Out<typeof O.EventOutSchema>, 'userType'> & { user_type: string };

export const toEvent = ({ user_type, ts, ...row }: Stored) => ({
  ...row,
  ts: iso(ts),
  userType: user_type,
});
export type EventOut = ReturnType<typeof toEvent>;

export const cursorOf = (row: Stored) =>
  Buffer.from(JSON.stringify([row.ts, row.id])).toString('base64url');
const fromCursor = (cursor: string) => {
  const pair: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString() || 'null');
  if (Array.isArray(pair) && pair.length === 2) return { cursorTs: pair[0], cursorId: pair[1] };
  throw new Error();
};

const parsedCursor = (cursor?: string) => {
  if (!cursor) return {};
  try {
    return fromCursor(cursor);
  } catch {
    throw fail('VALIDATION_ERROR', 'Invalid cursor');
  }
};

// Newest first; one extra row says a next page exists.
export const search = async (store: EventsStore, { cursor, limit, ...filters }: Search) => {
  const params: Record<string, unknown> = { ...filters, ...parsedCursor(cursor), limit: limit + 1 };
  const keys = Object.keys(SQL.FILTERS).filter(
    (key) => params[key === 'cursor' ? 'cursorTs' : key] !== undefined
  );
  const where = keys.map((key) => SQL.FILTERS[key as keyof typeof SQL.FILTERS]).join(' AND ');
  const rows = await store.query<Stored>(SQL.SEARCH(where), params);
  const page = rows.slice(0, limit);
  const last = rows.length > limit ? page.at(-1) : undefined;
  return { events: page.map(toEvent), nextCursor: last && cursorOf(last) };
};

// Every event of one agcid in time order; hops = the request rows (http, mcp).
export const trace = async (store: EventsStore, agcid: string) => {
  const rows = await store.query<Stored>(SQL.TRACE, {
    agcid,
  });
  const start = Math.min(...rows.map((row) => Date.parse(iso(row.ts)) - row.ms));
  const end = Math.max(...rows.map((row) => Date.parse(iso(row.ts))));
  const hops = rows.filter((row) => row.kind === 'http' || row.kind === 'mcp').length;
  const ms = rows.length > 0 ? end - start : 0;
  return { agcid, hops, ms, ok: rows.every((row) => row.ok), events: rows.map(toEvent) };
};

export const StatsSchema = z.object({
  window: z.enum(['15m', '1h', '24h']).default('1h'),
  extension: name.optional(),
});
const onExtension = (extension?: string) =>
  extension ? ' AND extension = {extension:String}' : '';

export const stats = async (
  store: EventsStore,
  { window, extension }: z.output<typeof StatsSchema>
) => {
  const since = Since.parse(window);
  const rows = await store.query<
    Omit<Out<typeof O.StatOutSchema>, 'p50' | 'p95' | 'p99'> & { q: number[] }
  >(SQL.STATS(onExtension(extension)), {
    since,
    extension,
  });
  return rows.map(({ q, ...row }) => ({ ...row, p50: q[0] ?? 0, p95: q[1] ?? 0, p99: q[2] ?? 0 }));
};

export const hosts = (store: EventsStore) =>
  store
    .query<Out<typeof O.HostOutSchema>>(SQL.HOSTS)
    .then((rows) => rows.map((row) => ({ ...row, at: iso(row.at), red: Boolean(row.red) })));

export const containers = (store: EventsStore, host: string) =>
  store.query<Out<typeof O.ContainerOutSchema>>(SQL.CONTAINERS, { host });

export const ErrorsSchema = z.object({ since: Since.prefault('24h'), extension: name.optional() });
export const errors = (store: EventsStore, { since, extension }: z.output<typeof ErrorsSchema>) =>
  store
    .query<Omit<Out<typeof O.ErrorOutSchema>, 'msg'> & { sample: string }>(
      SQL.ERRORS(onExtension(extension)),
      { since, extension }
    )
    .then((rows) =>
      rows.map(({ sample, ...row }) => ({ ...row, msg: sample, lastSeen: iso(row.lastSeen) }))
    );
