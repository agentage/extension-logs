import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStore } from '../lib/clickhouse.fixture.js';
import { groups } from '../lib/groups.js';
import { GroupsQuery } from '../lib/groups.schema.js';
import * as R from '../lib/reads.js';
import { G, GAPS, TIES, UNION, at } from './gaps.fixture.js';
import { toRow } from './rows.js';

// The 0.4 additions against a real ClickHouse 26.8; skipped without CLICKHOUSE_URL.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_gaps');
const ask = async (query: Record<string, unknown>) =>
  (await groups(db!.store, GroupsQuery.parse({ extension: 'gaps', ...query }))).groups;
const rows = async (query: Record<string, unknown>) =>
  (await R.search(db!.store, R.SearchSchema.parse(query))).events;
const pick = (list: Record<string, unknown>[], ...keys: string[]) =>
  list.map((row) => keys.map((key) => row[key]));

describe.runIf(db)('the 0.4 additions on ClickHouse', () => {
  beforeAll(async () => {
    await db?.reset();
    await db!.store.insert([...GAPS, ...TIES, ...UNION].map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('1. http,mcp is one number: quantiles and users over the union, kind a group', async () => {
    expect(await ask({ kind: 'http,mcp' })).toEqual([
      expect.objectContaining({ calls: 7, failed: 2, requests: 7, p50: 30, users: 3 }),
    ]);
    const split = await ask({ kind: 'http,mcp', by: 'kind', sort: 'kind', order: 'asc' });
    expect(pick(split, 'kind', 'calls', 'failed', 'users')).toEqual([
      ['http', 5, 1, 2],
      ['mcp', 2, 1, 2],
    ]);
    const union = await ask({ kind: 'mcp,http', extension: 'union', by: 'kind', sort: 'kind' });
    expect(pick(union, 'kind', 'calls', 'failed', 'requests')).toEqual([
      ['mcp', 2, 1, 2],
      ['http', 5, 2, 3],
    ]);
    expect(await ask({ kind: 'http,mcp', extension: 'union' })).toEqual([
      expect.objectContaining({ calls: 7, failed: 3, requests: 5 }),
    ]);
  });

  it('2. any counts every kind, with its first and last row', async () => {
    const all = await ask({ kind: 'any', by: 'kind', sort: 'kind', order: 'asc' });
    expect(pick(all, 'kind', 'count')).toEqual([
      ['error', 3],
      ['event', 9],
      ['http', 7],
      ['mcp', 2],
    ]);
    expect(all[2]).toMatchObject({ firstSeen: at(0), lastSeen: at(6) });
  });

  it('3. /events reads the slowest and the failed rows', async () => {
    const slow = await rows({ kind: 'http', extension: 'gaps', sort: 'ms' });
    expect(slow.map((e) => e['ms'])).toEqual([60, 50, 40, 30, 20, 10, 5]);
    const fast = await rows({
      kind: 'http',
      extension: 'gaps',
      sort: 'ms',
      order: 'asc',
      limit: 2,
    });
    expect(fast.map((e) => e['ms'])).toEqual([5, 10]);
    const failed = await rows({ extension: 'gaps', ok: 'false', sort: 'ms' });
    expect(failed.map((e) => [e['kind'], e['ms']])).toEqual([
      ['mcp', 200],
      ['http', 40],
    ]);
    expect(await rows({ extension: 'gaps', kind: 'http', ok: true })).toHaveLength(6);
  });

  it.each(['desc', 'asc'])('3. sort=ms pages ties by (ts, id), order %s', async (order) => {
    const query = { extension: 'ties', sort: 'ms', order };
    const all = (await rows(query)).map((e) => e['id']);
    const walked: unknown[] = [];
    for (let cursor: string | undefined, n = 0; n === 0 || cursor; n++) {
      const page = await R.search(db!.store, R.SearchSchema.parse({ ...query, limit: 2, cursor }));
      walked.push(...page.events.map((e) => e['id']));
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(5);
    expect(walked).toEqual(all);
  });

  it('4. under: the share at or under it per group, sortable; mcp too', async () => {
    const by = await ask({ kind: 'http', by: 'route', under: 25, sort: 'under', order: 'asc' });
    expect(pick(by, 'route', 'under')).toEqual([
      ['/a', 0.5],
      ['/b', 1],
    ]);
    expect(await ask({ kind: 'mcp', under: 150 })).toEqual([
      expect.objectContaining({ under: 0.5 }),
    ]);
    expect((await ask({ kind: 'http' }))[0]).not.toHaveProperty('under');
  });

  it('5. http groups carry firstSeen, lastSeen and one agcid', async () => {
    const [a] = await ask({ kind: 'http', route: '/a' });
    expect(a).toMatchObject({ firstSeen: at(0), lastSeen: at(3), agcid: G });
  });

  it('6. error groups by fingerprint', async () => {
    const fps = await ask({ kind: 'error', by: 'fingerprint' });
    expect(pick(fps, 'fingerprint', 'count')).toEqual([
      ['fp1', 2],
      ['fp2', 1],
    ]);
  });

  it('7. event: by name counts named events; the name filter counts and lists them', async () => {
    const names = await ask({ kind: 'event', by: 'name', sort: 'name', order: 'asc' });
    expect(pick(names, 'name', 'count')).toEqual([
      ['backup.run', 2],
      ['container.stats', 3],
      ['deploy.run', 1],
      ['host.stats', 3],
    ]);
    expect(await ask({ kind: 'event', name: 'backup.run' })).toEqual([{ count: 2 }]);
    expect(await rows({ extension: 'gaps', name: 'backup.run' })).toHaveLength(2);
    expect(await ask({ kind: 'any', name: 'backup.run' })).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
  });

  it('7. on container, name filters the container name, as by=name groups it', async () => {
    const [box] = await ask({ kind: 'container', name: 'gaps_api.1', since: '1h' });
    expect(box).toMatchObject({ mem: 500, mem_max: 900 });
    expect(await ask({ kind: 'container', name: 'container.stats', since: '1h' })).toEqual([]);
    const listed = await rows({ extension: 'gaps', kind: 'container', name: 'gaps_api.1' });
    expect(listed).toHaveLength(3);
  });

  it('8. by user_type keeps test and service rows; without it they stay out', async () => {
    const types = await ask({ kind: 'http', by: 'user_type', sort: 'user_type', order: 'asc' });
    expect(pick(types, 'user_type', 'calls')).toEqual([
      ['service', 1],
      ['test', 1],
      ['user', 5],
    ]);
    expect(await ask({ kind: 'http' })).toEqual([expect.objectContaining({ calls: 5 })]);
  });

  it('9. bucket=1d: one group per UTC day', async () => {
    const days = await ask({ kind: 'http', bucket: '1d', since: '2d' });
    expect(days.reduce((sum, day) => sum + Number(day['calls']), 0)).toBe(5);
    for (const day of days) expect(day['bucket']).toMatch(/T00:00:00\.000Z$/);
  });

  it('10. host mem_max, disk_max; container mem_max', async () => {
    const [host] = await ask({ kind: 'host', host: 'gaps-h', since: '1h' });
    expect(host).toMatchObject({ mem: 70, mem_max: 70, disk: 20, disk_max: 20, cpu: 25 });
    const [box] = await ask({ kind: 'container', host: 'gaps-h', since: '1h' });
    expect(box).toMatchObject({ mem: 500, mem_max: 900 });
  });

  it('11. fractions round: 2 decimals, shares 4; counts stay integers', async () => {
    const [host] = await ask({ kind: 'host', host: 'gaps-h', since: '1h' });
    expect(host?.['cpu_avg']).toBe(18.33);
    const [a] = await ask({ kind: 'http', route: '/a', under: 35 });
    expect(a).toMatchObject({ p95: 38.5, under: 0.75, calls: 4 });
    const [both] = await ask({ kind: 'http,mcp', under: 35 });
    expect(both?.['under']).toBe(0.5714);
  });
});
