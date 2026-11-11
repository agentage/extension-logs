import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as R from '../lib/reads.js';
import { testStore } from '../lib/clickhouse.fixture.js';
import { toRow } from './rows.js';
import { AGCID, VISITS } from './visits.fixture.js';

// The read SQL against a real ClickHouse 26.8; skipped without CLICKHOUSE_URL.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_reads');
const store = db?.store;
const s = store!;
const find = (query: object) => R.search(s, R.SearchSchema.parse(query));

describe.runIf(store)('the reads on ClickHouse, over the section 4 visits', () => {
  beforeAll(async () => {
    await db?.reset();
    await s.insert(VISITS.map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('search: q, level and extension narrow the rows, newest first', async () => {
    expect((await find({})).events).toHaveLength(VISITS.length);
    const errors = (await find({ level: 'error' })).events.map((e) => e['msg']);
    expect(errors).toEqual(['GET /api/v1/machines 502', 'POST /api/v1/emit 500', 'Error: forced']);
    expect((await find({ q: 'MACHINES', extension: 'platform' })).events).toHaveLength(3);
    expect((await find({ q: AGCID })).events).toHaveLength(5);
    expect((await find({ kind: 'event', host: 'next-2' })).events[0]).toMatchObject({
      userType: 'service',
    });
    expect((await find({ since: '1m' })).events).toHaveLength(3);
  });

  // A day old, so the other tests' 24 h and 1 h windows never see these rows, in any order.
  it('search: walking every page at limit 2 over rows with one ts has no gap and no overlap', async () => {
    const ts = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const same = [1, 2, 3, 4, 5].map((n) => ({
      ...VISITS[0],
      ts,
      extension: 'paging',
      agcid: null,
      user_type: 'test',
      msg: `page ${n}`,
    }));
    await s.insert(same.map(toRow) as object[]);
    const all = (await find({ extension: 'paging', since: '2d' })).events.map((e) => e['id']);
    const walked: unknown[] = [];
    for (let cursor: string | undefined, n = 0; n === 0 || cursor; n++) {
      const page = await find({
        extension: 'paging',
        since: '2d',
        limit: 2,
        ...(cursor && { cursor }),
      });
      walked.push(...page.events.map((e) => e['id']));
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(5);
    expect(walked).toEqual(all);
  });

  it('search: the trace as rows, oldest first, paged by a cursor in that order', async () => {
    const all = (await find({ agcid: AGCID, order: 'asc' })).events.map((e) => e['kind']);
    expect(all).toEqual(['http', 'mcp', 'error', 'http', 'http']);
    const walked: unknown[] = [];
    for (let cursor: string | undefined, n = 0; n === 0 || cursor; n++) {
      const page = await find({ agcid: AGCID, order: 'asc', limit: 2, ...(cursor && { cursor }) });
      walked.push(...page.events.map((e) => e['kind']));
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(all);
  });

  it('search: host and container kinds, sub, route and status narrow the rows', async () => {
    expect((await find({ kind: 'host' })).events.map((e) => e['host'])).toEqual([
      'next-2',
      'next-1',
      'next-gw',
      'next-1',
    ]);
    expect((await find({ kind: 'container' })).events).toHaveLength(2);
    expect((await find({ sub: 'usr_7f3a' })).events).toHaveLength(1);
    const failed = await find({ route: '/api/v1/machines', status: 502 });
    expect(failed.events.map((e) => e['part'])).toEqual(['edge']);
  });
});
