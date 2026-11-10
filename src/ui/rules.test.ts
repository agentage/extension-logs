import { describe, expect, it } from 'vitest';
import {
  clock,
  hostReasons,
  pct,
  realHosts,
  serviceReasons,
  services,
  traceHead,
  type Group,
  type Host,
} from './rules.js';

const NOW = Date.parse('2026-11-09T22:00:00.000Z');
const host = (over: Partial<Host> = {}): Host => ({
  ...{ host: 'next-1', cpu: 20, mem: 50, disk: 40, load1: 0.4, containers: 3 },
  at: '2026-11-09T21:59:30.000Z',
  ...over,
});
const group = (over: Partial<Group> = {}): Group => ({
  ...{ extension: 'platform', part: 'api', route: '/a', calls: 30, failed: 0, requests: 30 },
  p95: 40,
  ...over,
});
// The part sums and the route p95s from the same groups, as the widget reads them.
const row = (rows: Group[]) =>
  services(rows, rows).map(({ extension, part, calls, failed, p95, availability }) => ({
    ...{ extension, part, calls, failed, p95, availability },
  }));

describe('the hosts widget list', () => {
  it('leaves out the e2e gate hosts, e2e and e2e-..., and keeps every other name', () => {
    const names = ['e2e', 'e2e-1', 'e2e-gate-a', 'next-1', 'e2ex', 'node-e2e', 'E2E'];
    expect(realHosts(names.map((name) => host({ host: name }))).map((h) => h.host)).toEqual([
      'next-1',
      'e2ex',
      'node-e2e',
      'E2E',
    ]);
  });
});

describe('the hosts red rule', () => {
  it('a fresh host under every line has no reason', () => {
    expect(hostReasons(host(), NOW)).toEqual([]);
  });
  it('names the values over cpu 80, mem 85, disk 80; the lines themselves are not red', () => {
    expect(hostReasons(host({ cpu: 80.1, mem: 85, disk: 81 }), NOW)).toEqual([
      'cpu > 80',
      'disk > 80',
    ]);
    expect(hostReasons(host({ cpu: 80, mem: 85, disk: 80 }), NOW)).toEqual([]);
  });
  it('a newest sample older than 3 min is red by age; exactly 3 min is not', () => {
    expect(hostReasons(host({ cpu: null, at: '2026-11-09T21:56:59.000Z' }), NOW)).toEqual([
      'older than 3 min',
    ]);
    expect(hostReasons(host({ at: '2026-11-09T21:57:00.000Z' }), NOW)).toEqual([]);
  });
});

describe('the services red rule', () => {
  const svc = { extension: 'probe', part: 'api', calls: 9, failed: 0 };
  it('red when availability is a number under 99.0 % or p95 over 1000 ms', () => {
    expect(serviceReasons({ ...svc, availability: 0.989, p95: 10 })).toEqual(['avail < 99.0 %']);
    expect(serviceReasons({ ...svc, availability: 0.99, p95: 1000 })).toEqual([]);
    expect(serviceReasons({ ...svc, availability: 1, p95: 1001 })).toEqual(['p95 > 1000 ms']);
  });
  it('a null availability (under 50 requests) is not red', () => {
    expect(serviceReasons({ ...svc, availability: null, p95: 10 })).toEqual([]);
  });
});

describe('services from the /stats groups', () => {
  it('one row per extension and part: sums, the worst route p95, availability over the sums', () => {
    const rows = [
      group({ failed: 1 }),
      group({ route: '/b', p95: 900 }),
      group({ part: 'mcp', calls: 5, requests: 5 }),
    ];
    expect(row(rows)).toEqual(
      [
        ...[{ extension: 'platform', part: 'api', calls: 60, failed: 1, p95: 900 }],
        { extension: 'platform', part: 'mcp', calls: 5, failed: 0, p95: 40, availability: null },
      ].map((r) => ({ availability: 1 - 1 / 60, ...r }))
    );
  });
  it('availability needs 50 requests: 49 is a dash, 50 a number', () => {
    expect(row([group({ requests: 49 })])[0]?.availability).toBeNull();
    expect(row([group({ requests: 50, failed: 1 })])[0]?.availability).toBe(0.98);
  });
  it('edge rows are left out; a part with no route row has p95 0', () => {
    const edge = group({ part: 'edge', requests: 60, failed: 60 });
    expect(row([group(), edge]).map(({ part }) => part)).toEqual(['api']);
    expect(services([group()], [])[0]?.p95).toBe(0);
  });
});

describe('the trace header from its rows', () => {
  const hop = (ts: string, kind = 'http', ok = true, ms = 3) => ({ ts, kind, ok, ms });
  it('counts request hops, first start to last end, failed when one row is not ok', () => {
    const rows = [hop('2026-11-09T21:59:30.000Z'), hop('2026-11-09T21:59:30.038Z', 'span')];
    expect(traceHead(rows)).toBe(' 1 hops · 41 ms · ok');
    expect(traceHead([...rows, hop('2026-11-09T21:59:30.040Z', 'mcp', false)])).toBe(
      ' 2 hops · 43 ms · failed'
    );
    expect(traceHead([])).toBe(' 0 hops · 0 ms · ok');
  });
});

it('formats a percent, a dash for null, and the clock of an ISO time', () => {
  expect([pct(12.345), pct(null), pct(99.5, 2), clock('2026-11-09T21:59:30.000Z')]).toEqual([
    '12.3%',
    '-',
    '99.50%',
    '21:59:30',
  ]);
});
