import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { fail, type Log } from '@agentage/extension';
import { type Connection } from './connection.js';
import { EVENTS_DDL } from './ddl.js';

export type Params = Record<string, unknown>;
export type Row = Record<string, unknown>;

// The narrow face of @clickhouse/client the parts use; tests pass a fake.
export interface Clickhouse {
  command(sql: string): Promise<void>;
  insert(table: string, rows: object[]): Promise<void>;
  query<T = Row>(sql: string, params?: Params): Promise<T[]>;
  ping(): Promise<boolean>;
}

export interface EventsStore {
  ready(): Promise<void>;
  insert(rows: object[]): Promise<void>;
  query<T = Row>(sql: string, params?: Params): Promise<T[]>;
}

const ISO_TS = { date_time_input_format: 'best_effort' } as const;
// Counts as JSON numbers, not quoted UInt64; the server stops a read before the client's 10 s.
const READS = { output_format_json_quote_64bit_integers: 0, max_execution_time: 9 } as const;
// Under the kit's 1 s health bound, so a hung store never stacks probes.
const PING_MS = 900;

export const clickhouse = (connection: Connection): Clickhouse => {
  // Its own logger writes plain-text lines to stderr; failures reach the part's JSON log instead.
  const log = { level: ClickHouseLogLevel.OFF };
  const client = createClient({ ...connection, request_timeout: 10_000, log });
  const settings = { format: 'JSONEachRow', clickhouse_settings: ISO_TS } as const;
  return {
    command: async (query) => void (await client.command({ query })),
    insert: async (table, values) => void (await client.insert({ table, values, ...settings })),
    query: async <T = Row>(query: string, query_params?: Params) =>
      (
        await client.query({
          query,
          query_params,
          format: 'JSONEachRow',
          clickhouse_settings: READS,
        })
      ).json<T>(),
    ping: async () =>
      (await client.ping({ select: true, abort_signal: AbortSignal.timeout(PING_MS) })).success,
  };
};

// Opened on first use: the kit's tool runs create(ctx) to read routes and tools, nothing mounted.
export const lazy = (open: () => Clickhouse, log: Log): Clickhouse => {
  let ch: Clickhouse | undefined;
  const get = () => {
    try {
      return (ch ??= open());
    } catch (err) {
      log.error(err);
      throw err;
    }
  };
  return {
    command: async (sql) => get().command(sql),
    insert: async (table, rows) => get().insert(table, rows),
    query: async (sql, params) => get().query(sql, params),
    ping: async () => get().ping(),
  };
};

// checks.clickhouse on /health: a SELECT 1 with the store's credentials.
export const clickhouseCheck = (ch: Clickhouse) => async () =>
  (await ch.ping()) ? ('ok' as const) : ('unavailable' as const);

const OUTAGE = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE)$/;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isOutage = (err: unknown): boolean =>
  OUTAGE.test(String((err as { code?: unknown } | null)?.code)) || /timeout/i.test(messageOf(err));

// The DDL runs at start and, if the store was down then, again before the next use.
export const createEventsStore = (ch: Clickhouse, log: Log): EventsStore => {
  let table: Promise<void> | undefined;
  const ddl = () =>
    (table ??= ch.command(EVENTS_DDL).catch((err: unknown) => {
      table = undefined;
      throw err;
    }));
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      await ddl();
      return await work();
    } catch (err) {
      if (!isOutage(err)) throw err;
      log.warn('store unavailable', { reason: messageOf(err) });
      throw fail('UNAVAILABLE', 'The store is unavailable');
    }
  };
  return {
    ready: () => guard(async () => undefined),
    insert: (rows) => guard(() => ch.insert('events', rows)),
    query: (sql, params) => guard(() => ch.query(sql, params)),
  };
};
