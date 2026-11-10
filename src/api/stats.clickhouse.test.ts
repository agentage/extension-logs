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

// The hosts red rule at its lines: cpu 80, mem 85, disk 80 are not red, a tenth over is.
const sample = (host: string, cpu: number, mem: number, disk: number) => ({
  ...{ ts, level: 'info', kind: 'event', msg: `host.stats ${host}`, extension: 'estate' },
  ...{ part: 'agent', host, user_type: 'service' },
  fields: {
    'event.name': 'host.stats',
    'agentage.host.cpu_pct': cpu,
    'agentage.host.mem_pct': mem,
    'agentage.host.disk_pct': disk,
  },
});

describe.runIf(db)('the stats and hosts formulas on ClickHouse', () => {
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

  it('availability is the admin formula from 50 requests: 50 is a number, 49 null', async () => {
    const floor = (route: string, n: number) => [
      ...Array<object>(n - 1).fill(line(route, 200, { extension: 'floor' })),
      line(route, 503, { extension: 'floor' }),
    ];
    await db!.store.insert(
      [...floor('/fifty', 50), ...floor('/forty-nine', 49)].map(toRow) as object[]
    );
    const { stats: rows } = await R.stats(db!.store, { window: '15m', extension: 'floor' });
    expect(rows.find((r) => r['route'] === '/fifty')).toMatchObject({
      requests: 50,
      failed: 1,
      availability: 1 - 1 / 50,
    });
    expect(rows.find((r) => r['route'] === '/forty-nine')).toMatchObject({
      requests: 49,
      availability: null,
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

  it('hosts: red only past cpu 80, mem 85, disk 80', async () => {
    const hosts = [
      sample('at-lines', 80, 85, 80),
      sample('cpu-over', 80.1, 85, 80),
      sample('mem-over', 80, 85.1, 80),
      sample('disk-over', 80, 85, 80.1),
    ];
    await db!.store.insert(hosts.map(toRow) as object[]);
    const rows = await R.hosts(db!.store);
    expect(rows.map((r) => [r['host'], r['red']])).toEqual([
      ['at-lines', false],
      ['cpu-over', true],
      ['disk-over', true],
      ['mem-over', true],
    ]);
  });
});
