import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStore } from '../lib/clickhouse.fixture.js';
import * as R from '../lib/reads.js';
import { toRow } from './rows.js';

// The reliability formula row by row: a failed tool call, a 429, service and test traffic.
const db = testStore(process.env['CLICKHOUSE_URL'], 'logs_formula');
const ts = new Date(Date.now() - 60_000).toISOString();
const line = (route: string, status: number, extra: object = {}) => ({
  ts,
  level: 'info',
  kind: 'http',
  msg: route,
  extension: 'formula',
  part: 'api',
  user_type: 'user',
  fields: {
    'http.request.method': 'GET',
    'http.route': route,
    'http.response.status_code': status,
  },
  ...extra,
});
const tool = (error: boolean) => ({
  ...line('', 0),
  kind: 'mcp',
  part: 'mcp',
  fields: { 'gen_ai.tool.name': 'formula__t', ...(error && { 'error.type': 'Error' }) },
});
const ROWS = [
  line('/a', 200),
  line('/a', 429),
  line('/a', 500, { user_type: 'service' }),
  line('/a', 500, { user_type: 'test' }),
  tool(true),
  tool(false),
];

describe.runIf(db)('the stats formula on ClickHouse', () => {
  beforeAll(async () => {
    await db?.reset();
    await db?.store.insert(ROWS.map(toRow) as object[]);
  });
  afterAll(() => db?.drop());

  it('a 429 leaves requests; service and test traffic are left out', async () => {
    const { stats: rows } = await R.stats(db!.store, { window: '15m', extension: 'formula' });
    expect(rows.find((r) => r['route'] === '/a')).toMatchObject({
      calls: 2,
      requests: 1,
      failed: 0,
      errors: 0,
    });
  });

  it('a failed tool call counts as failed, an ok one as a request', async () => {
    const { stats: rows } = await R.stats(db!.store, { window: '15m', extension: 'formula' });
    expect(rows.find((r) => r['kind'] === 'mcp')).toMatchObject({
      route: 'formula__t',
      calls: 2,
      requests: 2,
      failed: 1,
    });
  });

  it('caps edge routes at 200 per part, keeps the quiet routes of a part, says truncated', async () => {
    const crowd = (part: string, route: string) => ({
      ...line(route, 200),
      extension: 'crowd',
      part,
    });
    const edge = Array.from({ length: 205 }, (_, i) => [
      crowd('edge', `/e${i}`),
      crowd('edge', `/e${i}`),
    ]);
    const quiet = ['/q1', '/q2', '/q3'].map((route) => crowd('api', route));
    await db!.store.insert([...edge.flat(), ...quiet].map(toRow) as object[]);
    const { stats, truncated } = await R.stats(db!.store, { window: '15m', extension: 'crowd' });
    expect(truncated).toBe(true);
    expect(stats.filter((r) => r['part'] === 'edge')).toHaveLength(200);
    expect(stats.filter((r) => r['part'] === 'api')).toHaveLength(3);
    expect((await R.stats(db!.store, { window: '15m', extension: 'formula' })).truncated).toBe(
      false
    );
  });
});
