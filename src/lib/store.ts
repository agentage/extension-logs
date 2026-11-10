import { createHash } from 'node:crypto';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { fail, type Log } from '@agentage/extension';
import { type Connection } from './connection.js';
import { DEDUP_SETTING, EVENTS_DDL, EVENTS_DEDUP, SHOW_EVENTS } from './ddl.js';

type Params = Record<string, unknown>;
export type Row = Record<string, unknown>;

// The narrow face of @clickhouse/client the parts use; tests pass a fake.
export interface Clickhouse {
  command(sql: string): Promise<void>;
  insert(table: string, rows: object[], token: string): Promise<void>;
  query<T = Row>(sql: string, params?: Params, signal?: AbortSignal): Promise<T[]>;
  ping(): Promise<boolean>;
}

export interface EventsStore {
  ready(): Promise<void>;
  insert(rows: object[]): Promise<void>;
  query<T = Row>(sql: string, params?: Params): Promise<T[]>;
}

// 26.8 inserts async by default; the token makes a retried batch a no-op (README, Ingest).
const writes = (token: string) =>
  ({
    format: 'JSONEachRow',
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
      async_insert_deduplicate: 1,
      insert_deduplication_token: token,
    },
  }) as const;
// Counts as JSON numbers; the server stops a read before the client gives up, and caps its memory on the 2 GB box.
const reads = (timeoutMs: number) =>
  ({
    format: 'JSONEachRow',
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
      max_execution_time: Math.max(1, timeoutMs / 1000 - 1),
      max_memory_usage: '268435456',
      max_result_rows: '10000',
      result_overflow_mode: 'throw',
    },
  }) as const;
// Under the kit's 1 s health bound, so a hung store never stacks probes.
const PING_MS = 900;

export const clickhouse = (connection: Connection, timeoutMs = 10_000): Clickhouse => {
  // Its own logger writes plain-text lines to stderr; failures reach the part's JSON log instead.
  const log = { level: ClickHouseLogLevel.OFF };
  const client = createClient({ ...connection, request_timeout: timeoutMs, log });
  const READS = reads(timeoutMs);
  return {
    command: async (query) => void (await client.command({ query })),
    insert: async (table, values, token) =>
      void (await client.insert({ table, values, ...writes(token) })),
    query: async <T = Row>(query: string, query_params?: Params, abort_signal?: AbortSignal) =>
      (await client.query({ query, query_params, ...READS, abort_signal })).json<T>(),
    ping: async () =>
      (await client.ping({ select: true, abort_signal: AbortSignal.timeout(PING_MS) })).success,
  };
};

// Opened on first use (the kit's tool runs create(ctx) with nothing mounted); no connection is a 503.
export const lazy = (open: () => Clickhouse, log: Log): Clickhouse => {
  let ch: Clickhouse | undefined;
  const get = () => {
    try {
      return (ch ??= open());
    } catch (err) {
      log.error(err);
      throw fail('UNAVAILABLE', 'The store is unavailable');
    }
  };
  return {
    command: async (sql) => get().command(sql),
    insert: async (table, rows, token) => get().insert(table, rows, token),
    query: async (...args) => get().query(...args),
    ping: async () => get().ping(),
  };
};

// checks.clickhouse on /health: a SELECT 1 with the store's credentials.
export const clickhouseCheck = (ch: Clickhouse) => async () =>
  (await ch.ping()) ? ('ok' as const) : ('unavailable' as const);

const GIB = 1024 ** 3;
// The estate keeps a 1 GiB reserve the store will not write into; 1.5 GiB warns first. No row reads unavailable.
const FREE = 'SELECT min(free_space) AS free FROM system.disks';
export const diskCheck = (ch: Clickhouse) => async () => {
  const [row] = await ch.query<{ free: number }>(FREE, {}, AbortSignal.timeout(PING_MS));
  const free = Number(row?.free);
  if (!(free >= GIB)) return 'unavailable' as const;
  return free < 1.5 * GIB ? ('degraded' as const) : ('ok' as const);
};

const OUTAGE = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE)$/;
// ClickHouse's own limits: 159 timeout, 202 too many queries, 241 memory, 252 too many parts, 396 rows.
const BUSY = /^(159|202|241|252|396)$/;
// It cannot write: 243 no space, 242 table read-only, 204 fsync, 294 and 75 write, 173 allocate.
const FULL = /^(243|242|204|294|75|173)$/;
const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isOutage = (err: unknown): boolean =>
  OUTAGE.test(codeOf(err)) || /timeout/i.test(messageOf(err));

// A connection fault or a store limit is a 503 with a warning; any other error passes through.
const reasonOf = (err: unknown) => {
  if (BUSY.test(codeOf(err))) return 'The store is busy: narrow the query or retry';
  if (FULL.test(codeOf(err))) return 'The store cannot write now: retry later';
  return isOutage(err) ? 'The store is unavailable' : undefined;
};
const unavailable = (log: Log) => (err: unknown) => {
  const reason = reasonOf(err);
  if (!reason) throw err;
  log.warn('store unavailable', { reason: messageOf(err) });
  throw fail('UNAVAILABLE', reason);
};
// One token per batch: a shipper retry of the same rows is dropped by the store.
const tokenOf = (rows: object[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

// The ALTER only when the table lacks the setting: a table set once needs no ALTER right again.
const prepare = async (ch: Clickhouse) => {
  await ch.command(EVENTS_DDL);
  const [table] = await ch.query<{ statement?: string }>(SHOW_EVENTS);
  if (!table?.statement?.includes(DEDUP_SETTING)) await ch.command(EVENTS_DEDUP);
};

// The DDL runs at start and, if the store was down then, again before the next use.
export const createEventsStore = (ch: Clickhouse, log: Log): EventsStore => {
  let table: Promise<void> | undefined;
  const ddl = () =>
    (table ??= prepare(ch).catch((err: unknown) => {
      table = undefined;
      throw err;
    }));
  const guard = <T>(work: () => Promise<T>): Promise<T> => ddl().then(work).catch(unavailable(log));
  return {
    ready: () => guard(async () => undefined),
    insert: (rows) => guard(() => ch.insert('events', rows, tokenOf(rows))),
    query: (sql, params) => guard(() => ch.query(sql, params)),
  };
};
