import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStore } from '../lib/clickhouse.fixture.js';
import { groups } from '../lib/groups.js';
import { GroupsQuery } from '../lib/groups.schema.js';
import { toRow } from './rows.js';
import { VISITS } from './visits.fixture.js';

// The /stats groups against a real ClickHouse 26.8; skipped without CLICKHOUSE_URL.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_groups');
const s = db?.store;
const ask = async (query: Record<string, unknown>) => groups(s!, GroupsQuery.parse(query as never));
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const hit = (route: string, status: number, sec = 120, extra: object = {}) => ({
  ...{ ts: ago(sec), level: status >= 500 ? 'error' : 'info', kind: 'http', msg: route },
  ...{ extension: 'board', part: 'api', user_type: 'user', sub: 'usr_a', host: 'next-1' },
  fields: {
    ...{ 'http.request.method': 'GET', 'http.route': route },
    ...{ 'http.response.status_code': status, 'agentage.duration_ms': 10 },
  },
  ...extra,
});
// /busy: 60 requests, one failed (an availability); /quiet and /slow: under 50 (null).
const BOARD = [
  ...Array.from({ length: 59 }, () => hit('/busy', 200)),
  hit('/busy', 503),
  hit('/quiet', 200),
  hit('/quiet', 500),
  hit('/slow', 200, 120, { fields: { 'http.route': '/slow', 'agentage.duration_ms': 900 } }),
];

describe.runIf(s)('GET /stats with kind on ClickHouse', () => {
  beforeAll(async () => {
    await db?.reset();
    await s!.insert([...VISITS, ...BOARD].map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('http by extension, part, route: the admin formula per group, test traffic out', async () => {
    const { groups: rows, meta } = await ask({ kind: 'http', by: 'extension,part,route' });
    const at = (part: string, route: string) =>
      rows.find((r) => r['part'] === part && r['route'] === route);
    expect(at('api', '/api/v1/machines')).toMatchObject({
      ...{ extension: 'platform', calls: 2, failed: 0, requests: 2, availability: null },
      users: 1,
    });
    expect(at('edge', '/api/v1/machines')).toMatchObject({ failed: 1, requests: 1 });
    expect(at('api', '/busy')).toMatchObject({ calls: 60, failed: 1, availability: 1 - 1 / 60 });
    expect(rows.find((r) => r['extension'] === 'probe')).toMatchObject({ calls: 1, failed: 1 });
    expect(meta).toEqual({
      ...{ kind: 'http', by: ['extension', 'part', 'route'], sort: 'calls', order: 'desc' },
      ...{ since: '24h', truncated: false },
    });
  });

  it('user_type=test asks for the test rows; by status splits one extension', async () => {
    const test = await ask({ kind: 'http', user_type: 'test' });
    expect(test.groups).toEqual([expect.objectContaining({ calls: 1, failed: 0 })]);
    const status = await ask({ kind: 'http', by: 'status', extension: 'platform' });
    expect(status.groups.map((r) => [r['status'], r['calls']])).toEqual([
      [200, 1],
      [401, 1],
      [502, 1],
    ]);
  });

  it('sorts on a measure and on a column; a group without a value sorts last', async () => {
    const worst = await ask({
      kind: 'http',
      extension: 'board',
      by: 'route',
      sort: 'availability',
      order: 'asc',
    });
    expect(worst.groups.map((r) => r['route'])).toEqual(['/busy', '/quiet', '/slow']);
    const best = await ask({ kind: 'http', extension: 'board', by: 'route', sort: 'availability' });
    expect(best.groups.map((r) => r['route'])).toEqual(['/busy', '/quiet', '/slow']);
    const slow = await ask({ kind: 'http', extension: 'board', by: 'route', sort: 'p95' });
    expect(slow.groups[0]).toMatchObject({ route: '/slow', p95: 900 });
    const names = await ask({ kind: 'http', by: 'route', sort: 'route', order: 'asc' });
    const routes = names.groups.map((r) => String(r['route']));
    expect(routes).toEqual([...routes].sort());
  });

  it('pages by a cursor over a pinned window: rows sent between pages never show', async () => {
    const query = { kind: 'http', extension: 'board', by: 'route', limit: 1 };
    const first = await ask(query);
    expect(first.meta).toMatchObject({ truncated: true, nextCursor: expect.any(String) });
    await s!.insert(Array.from({ length: 80 }, () => toRow(hit('/late', 200, 0))) as object[]);
    const walked = first.groups.map((r) => r['route']);
    for (let cursor = first.meta.nextCursor; cursor;) {
      const page = await ask({ ...query, cursor });
      walked.push(...page.groups.map((r) => r['route']));
      cursor = page.meta.nextCursor;
    }
    expect(walked).toEqual(['/busy', '/quiet', '/slow']);
    const ahead = new Date(Date.now() + 60_000).toISOString();
    expect((await ask({ ...query, until: ahead })).groups[0]).toMatchObject({ route: '/late' });
  });

  it('host by host: the newest sample, the window average and peak, its time', async () => {
    const { groups: rows } = await ask({ kind: 'host', by: 'host', sort: 'host', order: 'asc' });
    expect(rows.map((r) => r['host'])).toEqual(['next-1', 'next-2', 'next-gw']);
    expect(rows[0]).toMatchObject({ cpu: 12.4, cpu_avg: 31.2, cpu_max: 50, mem: 61 });
    expect(rows[0]?.['at']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('host with a bucket: a step average per 5 minutes, oldest first', async () => {
    const { groups: rows, meta } = await ask({
      kind: 'host',
      host: 'next-1',
      bucket: '5m',
      since: '30m',
    });
    expect(meta).toMatchObject({ sort: 'bucket', order: 'asc' });
    expect(rows.map((r) => r['cpu'])).toEqual([50, 12.4]);
    expect(String(rows[0]?.['bucket'])).toMatch(/:[0-5][05]:00\.000Z$/);
  });

  it('container by name on one host, heaviest first; error by type with a sample', async () => {
    const boxes = await ask({ kind: 'container', host: 'next-1', by: 'name' });
    expect(boxes.groups.map((r) => [r['name'], r['cpu']])).toEqual([
      ['root_api.1', 7.5],
      ['platform_api.1', 3.1],
    ]);
    const errors = await ask({ kind: 'error', by: 'type', sort: 'lastSeen' });
    expect(errors.groups).toEqual([
      expect.objectContaining({
        type: 'Error',
        count: 1,
        sample: 'Error: forced',
        agcid: 'a'.repeat(32),
      }),
    ]);
  });

  it.each([
    { kind: 'http', by: 'extension,part,route', since: '24h' },
    { kind: 'http', by: 'status', extension: 'market' },
    { kind: 'mcp', by: 'route' },
    { kind: 'http', by: 'sub', since: '7d' },
    { kind: 'error', by: 'type' },
    { kind: 'host', by: 'host' },
    { kind: 'container', host: 'next-1', by: 'name' },
    { kind: 'host', by: 'host', bucket: '5m', since: '6h' },
    { kind: 'http', extension: 'probe', bucket: '1h', since: '24h' },
    {
      kind: 'http',
      by: 'extension,part,route',
      since: '24h',
      sort: 'availability',
      order: 'asc',
      limit: 3,
    },
    { kind: 'http', by: 'extension,route', since: '24h', sort: 'p95', order: 'desc', limit: 20 },
    { kind: 'mcp', by: 'route', sort: 'failed' },
    { kind: 'error', by: 'type,extension', sort: 'lastSeen' },
    { kind: 'host', by: 'host', sort: 'mem' },
    { kind: 'http', by: 'route', sort: 'route', order: 'asc' },
    { kind: 'mcp', by: 'route,client', since: '24h' },
    { kind: 'http', by: 'sub,user_type', since: '7d', limit: 10 },
    { kind: 'job', by: 'extension,route', since: '7d' },
    { kind: 'container', by: 'host,name', limit: 5 },
    { kind: 'span' },
    { kind: 'log', by: 'extension,part' },
    { kind: 'event', bucket: '1m' },
  ])('the page example %o answers', async (query) => {
    const { meta } = await ask(query);
    expect(meta.kind).toBe(query.kind);
  });

  it('no grouping is one line for the window, none when no row passes', async () => {
    expect((await ask({ kind: 'mcp', since: '24h' })).groups).toEqual([
      expect.objectContaining({ calls: 1, failed: 0, users: 0 }),
    ]);
    expect((await ask({ kind: 'job' })).groups).toEqual([]);
  });
});
