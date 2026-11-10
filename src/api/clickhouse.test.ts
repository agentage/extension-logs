import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStore } from '../lib/clickhouse.fixture.js';
import { DEDUP_SETTING, SHOW_EVENTS } from '../lib/ddl.js';
import { clickhouseCheck } from '../lib/store.js';
import { OLDEST } from '../worker/retention.js';
import { LINES } from './lines.fixture.js';
import { toRow } from './rows.js';

// Against a real ClickHouse 26.8 (CI service, or docker locally); skipped without CLICKHOUSE_URL.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_ingest');
const store = db?.store;
const raw = { ...LINES.log, msg: 'LOG: checkpoint complete', fields: { 'agentage.raw': true } };

describe.runIf(store)('the events table on ClickHouse', () => {
  beforeAll(async () => {
    await db?.reset();
    await store?.ready();
    await store?.ready();
    await store?.insert([...Object.values(LINES), raw].map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('has the dedup setting where SHOW CREATE shows it, so a restart skips the ALTER', async () => {
    const [table] = await store!.query<{ statement: string }>(SHOW_EVENTS);
    expect(table?.statement).toContain(DEDUP_SETTING);
  });

  it('answers checks.clickhouse ok', async () => {
    expect(await clickhouseCheck(db!.ch)()).toBe('ok');
  });

  it('stores one row per line, with the time and the agcid as sent', async () => {
    const rows = await store!.query<{ kind: string; ts: string; agcid: string | null }>(
      'SELECT kind, toString(ts) AS ts, agcid FROM events ORDER BY kind'
    );
    expect(rows.map((row) => row.kind)).toEqual([
      'error',
      'event',
      'http',
      'job',
      'log',
      'log',
      'mcp',
      'span',
    ]);
    expect(rows[0]).toEqual({
      kind: 'error',
      ts: LINES.error.ts.replace('T', ' ').replace('Z', ''),
      agcid: LINES.error.agcid,
    });
    expect(rows.filter((row) => row.agcid === null)).toHaveLength(1);
  });

  it('reads a dotted field as a path and the promoted columns', async () => {
    const [row] = await store!.query<object>(
      "SELECT fields.http.route AS route, status, ms, ok FROM events WHERE kind = 'http'"
    );
    expect(row).toEqual({ route: '/api/v1/machines', status: 401, ms: 1, ok: true });
  });

  it('stores 1000 lines of about 1 MB in one insert, and a retried batch adds no row', async () => {
    const fields = Object.fromEntries([0, 1, 2, 3].map((k) => [`load.k${k}`, 'v'.repeat(190)]));
    const one = (i: number) => ({ ...LINES.log, msg: `load ${i} `.padEnd(190, 'y'), fields });
    const batch = Array.from({ length: 1000 }, (_, i) => toRow(one(i))) as object[];
    expect(JSON.stringify(batch).length).toBeGreaterThan(1_000_000);
    await store!.insert(batch);
    await store!.insert(batch);
    const [row] = await store!.query<{ n: number }>(
      "SELECT count() AS n FROM events WHERE startsWith(msg, 'load ')"
    );
    expect(row?.n).toBe(1000);
  });

  it('sends the read limits to the server: 20000 rows throw at max_result_rows as UNAVAILABLE busy', async () => {
    await expect(store!.query('SELECT number FROM numbers(20000)')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'The store is busy: narrow the query or retry',
    });
    expect(await store!.query('SELECT number FROM numbers(10000)')).toHaveLength(10000);
  });

  it('answers a read over its limits as UNAVAILABLE busy, never a 500', async () => {
    const sql =
      "SELECT number FROM numbers(10) SETTINGS max_result_rows = 1, result_overflow_mode = 'throw'";
    await expect(store!.query(sql)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('answers the retention check with the oldest partition', async () => {
    const [row] = await store!.query<{ oldest: string }>(OLDEST);
    expect(row?.oldest).toBe(LINES.log.ts.slice(0, 10));
  });
});
