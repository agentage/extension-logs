import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStore } from '../lib/clickhouse.fixture.js';
import { groups } from '../lib/groups.js';
import { GroupsQuery } from '../lib/groups.schema.js';
import { GROUP_KINDS, KIND_DEFS } from '../lib/kinds.js';
import { toRow } from './rows.js';
import { VISITS } from './visits.fixture.js';

// Each kind's measures against rows of that kind; skipped without CLICKHOUSE_URL.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_kinds');
const ask = async (query: Record<string, unknown>) =>
  (await groups(db!.store, GroupsQuery.parse(query as never))).groups;
const ts = new Date(Date.now() - 120_000).toISOString();
const line = (kind: string, part: string, fields: object, extra: object = {}) => ({
  ...{ ts, level: 'info', kind, msg: kind, extension: 'kinds', part, user_type: 'user', fields },
  ...extra,
});
const http = (part: string, status: number) =>
  line('http', part, { 'http.route': '/k', 'http.response.status_code': status });
const ROWS = [
  ...[http('api', 200), http('api', 429), http('api', 500), http('edge', 500), http('edge', 503)],
  line('mcp', 'mcp', { 'gen_ai.tool.name': 'kinds__t', 'error.type': 'Error' }),
  line('mcp', 'mcp', { 'gen_ai.tool.name': 'kinds__t' }),
  ...[10, 30].map((ms) => line('job', 'worker', { 'agentage.duration_ms': ms })),
  line('job', 'worker', { 'agentage.duration_ms': 50, 'error.type': 'Error' }),
  ...[1, 2, 3].map((ms) => line('span', 'api', { 'agentage.duration_ms': ms })),
  line('log', 'api', {}),
  line('event', 'api', { 'event.name': 'kinds.happened' }),
];

describe.runIf(db)('every kind of GET /stats on ClickHouse', () => {
  beforeAll(async () => {
    await db?.reset();
    await db!.store.insert([...VISITS, ...ROWS].map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('http: a 429 is no request; at the edge only 502 to 504 fail and count', async () => {
    const rows = await ask({
      kind: 'http',
      extension: 'kinds',
      by: 'part',
      sort: 'part',
      order: 'asc',
    });
    expect(rows).toEqual([
      expect.objectContaining({ part: 'api', calls: 3, failed: 1, requests: 2 }),
      expect.objectContaining({ part: 'edge', calls: 2, failed: 1, requests: 1 }),
    ]);
  });

  it('mcp: a tool call with an error fails; job: runs, failed, latency', async () => {
    expect(await ask({ kind: 'mcp', extension: 'kinds' })).toEqual([
      expect.objectContaining({ calls: 2, failed: 1, requests: 2 }),
    ]);
    expect(await ask({ kind: 'job', extension: 'kinds' })).toEqual([
      expect.objectContaining({ runs: 3, failed: 1, p50: 30 }),
    ]);
  });

  it('span, log and event count their rows; a 1m bucket splits time', async () => {
    expect(await ask({ kind: 'span', extension: 'kinds' })).toEqual([
      expect.objectContaining({ count: 3, p50: 2 }),
    ]);
    expect(await ask({ kind: 'log', extension: 'kinds', by: 'extension,part' })).toEqual([
      { extension: 'kinds', part: 'api', count: 1 },
    ]);
    const steps = await ask({ kind: 'event', extension: 'kinds', bucket: '1m' });
    expect(steps).toEqual([{ bucket: expect.stringMatching(/:00\.000Z$/), count: 1 }]);
  });

  it('availability is a number from 50 requests: 50 is one, 49 null', async () => {
    const floor = (route: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...line('http', 'api', { 'http.route': route, 'http.response.status_code': i ? 200 : 503 }),
        extension: 'floor',
      }));
    await db!.store.insert([...floor('/50', 50), ...floor('/49', 49)].map(toRow) as object[]);
    const rows = await ask({ kind: 'http', extension: 'floor', by: 'route', sort: 'route' });
    expect(rows.map((r) => [r['route'], r['requests'], r['availability']])).toEqual([
      ['/50', 50, 0.98],
      ['/49', 49, null],
    ]);
  });

  it.each(GROUP_KINDS)('%s answers by, bucket, a measure sort and a column sort', async (kind) => {
    const measure = Object.keys(KIND_DEFS[kind].measures)[0];
    const base = { kind, since: '1h', by: 'extension' };
    await expect(ask({ ...base, bucket: '1h', sort: measure })).resolves.toBeInstanceOf(Array);
    await expect(ask({ ...base, sort: 'extension', order: 'asc' })).resolves.toBeInstanceOf(Array);
  });
});
