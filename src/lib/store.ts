import { createHash } from 'node:crypto';
import { clickhouseOf, fail, type ClickhouseStore, type Log } from '@agentage/extension';
import { DEDUP_SETTING, EVENTS_DDL, EVENTS_DEDUP, SHOW_EVENTS } from './ddl.js';

type Params = Record<string, unknown>;
type ClickhouseParams = Parameters<ClickhouseStore['query']>[1] & object;
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

// 26.8 inserts async by default; the token makes a retried batch a no-op (docs/api.md, Ingest).
const writes = (token: string) => ({
  date_time_input_format: 'best_effort',
  async_insert_deduplicate: 1,
  insert_deduplication_token: token,
});
// Counts as JSON numbers; the server stops a read before the client gives up, and caps its memory on the 2 GB box.
const READS = {
  max_execution_time: 9,
  max_memory_usage: '268435456',
  max_result_rows: '10000',
  result_overflow_mode: 'throw',
  max_rows_to_group_by: '100000',
  group_by_overflow_mode: 'throw',
};
// Under the kit's 1 s health bound, so a hung store never stacks probes.
const PING_MS = 900;

// The kit opens the store (AGENTAGE_STORE_URL_FILE, params bound server-side); this is the face the parts use.
export const fromKit = (kit: ClickhouseStore): Clickhouse => ({
  command: (sql) => kit.command(sql),
  insert: (table, rows, token) => kit.insert(table, rows, { settings: writes(token) }),
  query: async <T = Row>(sql: string, params?: Params, signal?: AbortSignal) =>
    (await kit.query<Row>(sql, params as ClickhouseParams, { settings: READS, signal }))
      .rows as unknown as T[],
  ping: () => kit.ping(),
});

// ctx.store of a package with no clickhouse store (a check or test context) is a 503 with the cause logged.
export const openCh = (ctx: { readonly store: unknown }, log: Log): Clickhouse => {
  const kit = clickhouseOf(ctx);
  const ch = fromKit(kit);
  const guard =
    <T>(call: () => Promise<T>) =>
    async () => {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof Error) || !/^no clickhouse store/.test(err.message)) throw err;
        log.error(err);
        throw fail('UNAVAILABLE', 'The store is unavailable');
      }
    };
  return {
    command: (sql) => guard(() => ch.command(sql))(),
    insert: (t, rows, token) => guard(() => ch.insert(t, rows, token))(),
    query: <T = Row>(sql: string, params?: Params, signal?: AbortSignal) =>
      guard(() => ch.query<T>(sql, params, signal))(),
    ping: () => ch.ping(),
  };
};

// checks.clickhouse on /health: a SELECT 1 with the store's credentials.
export const clickhouseCheck = (ch: Clickhouse) => async () =>
  (await ch.ping()) ? ('ok' as const) : ('unavailable' as const);

const GIB = 1024 ** 3;
// The disks of the events table's policy (default before the table exists); unreserved_space already
// leaves out the estate's 1 GiB keep_free_space, so the disk's own free bytes are the two added.
const FREE = `SELECT min(unreserved_space + keep_free_space) AS free FROM system.disks
WHERE has((SELECT any(disks) FROM system.storage_policies WHERE policy_name = coalesce(nullIf((
  SELECT any(storage_policy) FROM system.tables WHERE database = currentDatabase() AND name = 'events'
), ''), 'default')), name)`;
// Never unavailable: a full disk stops writes (503 on ingest) while reads still serve the operator.
export const diskCheck = (ch: Clickhouse, log: Log) => async () => {
  try {
    const [row] = await ch.query<{ free: number }>(FREE, {}, AbortSignal.timeout(PING_MS));
    return Number(row?.free) >= 1.5 * GIB ? ('ok' as const) : ('degraded' as const);
  } catch (err) {
    log.warn('checks.disk cannot read system.disks', { reason: messageOf(err) });
    return 'degraded' as const;
  }
};

const OUTAGE = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE)$/;
// ClickHouse's own limits: 159 timeout, 202 queries, 241 and 173 memory, 252 parts, 396 and 158 rows.
const BUSY = /^(159|202|241|173|252|396|158)$/;
// It cannot write: 243 no space, 242 table read-only, 204 fsync, 294 and 75 write.
const FULL = /^(243|242|204|294|75)$/;
const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isOutage = (err: unknown): boolean =>
  OUTAGE.test(codeOf(err)) || /timeout/i.test(messageOf(err));

// A connection fault or a store limit is a 503 with a warning; any other error passes through.
const reasonOf = (err: unknown, write: boolean) => {
  if (BUSY.test(codeOf(err))) return 'The store is busy: narrow the query or retry';
  if (FULL.test(codeOf(err)) && write) return 'The store cannot write now: retry later';
  return isOutage(err) || FULL.test(codeOf(err)) ? 'The store is unavailable' : undefined;
};
const unavailable = (log: Log, write: boolean) => (err: unknown) => {
  const reason = reasonOf(err, write);
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
  const guard = <T>(work: () => Promise<T>, write = false): Promise<T> =>
    ddl().then(work).catch(unavailable(log, write));
  return {
    ready: () => guard(async () => undefined),
    insert: (rows) => guard(() => ch.insert('events', rows, tokenOf(rows)), true),
    query: (sql, params) => guard(() => ch.query(sql, params)),
  };
};
