import { createTestContext } from '@agentage/extension';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouse, createEventsStore } from '../lib/store.js';
import { OLDEST } from '../worker/retention.js';
import { LINES } from './lines.fixture.js';
import { toRow } from './rows.js';

// Against a real ClickHouse 26.8 (CI service, or docker locally); skipped without CLICKHOUSE_URL.
const url = process.env['CLICKHOUSE_URL'];
const ch = url ? clickhouse(url) : undefined;
const store = ch && createEventsStore(ch, createTestContext().log);
const raw = { ...LINES.log, msg: 'LOG: checkpoint complete', fields: { 'agentage.raw': true } };

describe.runIf(store)('the events table on ClickHouse', () => {
  beforeAll(async () => {
    await ch?.command('DROP TABLE IF EXISTS events');
    await store?.ready();
    await store?.ready();
    await store?.insert([...Object.values(LINES), raw].map(toRow) as object[]);
  });
  afterAll(() => ch?.command('DROP TABLE IF EXISTS events'));

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

  it('answers the retention check with the oldest partition', async () => {
    const [row] = await store!.query<{ oldest: string }>(OLDEST);
    expect(row?.oldest).toBe(LINES.log.ts.slice(0, 10));
  });
});
