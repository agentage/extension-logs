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
    const errors = (await find({ level: 'error' })).events.map((e) => e.msg);
    expect(errors).toEqual(['GET /api/v1/machines 502', 'POST /api/v1/emit 500', 'Error: forced']);
    expect((await find({ q: 'MACHINES', extension: 'platform' })).events).toHaveLength(3);
    expect((await find({ q: AGCID })).events).toHaveLength(5);
    expect((await find({ kind: 'event', host: 'next-2' })).events[0]).toMatchObject({
      userType: 'service',
    });
    expect((await find({ since: '1m' })).events).toHaveLength(3);
  });

  it('search: limit 2 gives a cursor; the next page has no overlap', async () => {
    const first = await find({ limit: 2 });
    const next = await find({ limit: 2, cursor: first.nextCursor });
    expect(first.nextCursor).toBeTypeOf('string');
    expect(next.events.map((e) => e.id)).not.toContain(first.events[0]?.id);
    expect(next.events[0]!.ts <= first.events[1]!.ts).toBe(true);
  });

  it('trace: time order, request hops, an unknown agcid is empty', async () => {
    const found = await R.trace(s, AGCID);
    expect(found.events.map((e) => e.kind)).toEqual(['http', 'mcp', 'error', 'http', 'http']);
    expect(found).toMatchObject({ hops: 4, ok: false });
    expect(await R.trace(s, 'f'.repeat(32))).toEqual({
      agcid: 'f'.repeat(32),
      hops: 0,
      ms: 0,
      ok: true,
      events: [],
    });
  });

  it('stats: a row per route and tool, test traffic out, availability null under 50 requests', async () => {
    const rows = await R.stats(s, { window: '1h' });
    const machines = rows.find((r) => r.part === 'api' && r.route === '/api/v1/machines');
    expect(machines).toMatchObject({
      extension: 'platform',
      calls: 2,
      failed: 0,
      requests: 2,
      availability: null,
      users: 1,
      p95: expect.any(Number),
    });
    expect(rows.find((r) => r.part === 'edge')).toMatchObject({ failed: 1, requests: 1 });
    expect(rows.find((r) => r.route === 'probe__echo')).toMatchObject({ kind: 'mcp', calls: 1 });
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(5);
  });

  it('stats: availability is the admin formula from 50 requests', async () => {
    const line = { ...(VISITS[0] as { fields: object }), ts: new Date().toISOString() };
    const fail = { ...line, fields: { ...line.fields, 'http.response.status_code': 503 } };
    await s.insert([...Array(48).fill(line), fail].map(toRow) as object[]);
    const rows = await R.stats(s, { window: '15m' });
    expect(rows.find((r) => r.route === '/api/v1/machines' && r.part === 'api')).toMatchObject({
      requests: 51,
      availability: 1 - 1 / 51,
    });
  });

  it('hosts: the last sample per host, red by age or threshold; containers by cpu', async () => {
    const rows = await R.hosts(s);
    expect(rows.map((r) => [r.host, r.cpu, r.red])).toEqual([
      ['next-1', 12.4, false],
      ['next-2', 91, true],
      ['next-gw', 5, true],
    ]);
    expect(rows[0]).toMatchObject({ cpu1h: 31.2, mem: 61, disk: 34.1, load1: 0.42, containers: 2 });
    const inside = await R.containers(s, 'next-1');
    expect(inside.map((c) => c.name)).toEqual(['root_api.1', 'platform_api.1']);
    expect(await R.containers(s, 'next-9')).toEqual([]);
  });

  it('errors: grouped by type and message, with one agcid', async () => {
    const rows = await R.errors(s, R.ErrorsSchema.parse({}));
    expect(rows).toEqual([
      expect.objectContaining({ type: 'Error', msg: 'Error: forced', count: 1, agcid: AGCID }),
    ]);
  });
});
