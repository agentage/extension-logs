import { describe, expect, it } from 'vitest';
import {
  clock,
  hostReasons,
  pct,
  serviceReasons,
  services,
  type Host,
  type Stat,
} from './rules.js';

const host = (over: Partial<Host> = {}): Host => ({
  host: 'next-1',
  cpu: 20,
  cpu1h: 18,
  mem: 50,
  disk: 40,
  load1: 0.4,
  containers: 3,
  at: '2026-11-09T21:59:30.000Z',
  red: false,
  ...over,
});
const stat = (over: Partial<Stat> = {}): Stat => ({
  extension: 'platform',
  part: 'api',
  kind: 'http',
  method: 'GET',
  route: '/a',
  calls: 30,
  errors: 0,
  failed: 0,
  requests: 30,
  users: 1,
  availability: null,
  p50: 10,
  p95: 40,
  p99: 90,
  ...over,
});
const row = (rows: Stat[]) =>
  services(rows).map(({ extension, part, calls, errors, p95, availability }) => ({
    extension,
    part,
    calls,
    errors,
    p95,
    availability,
  }));

describe('the hosts reason text (the api decides red)', () => {
  it('a host the api did not mark red has no reason, whatever its values', () => {
    expect(hostReasons(host({ cpu: 99 }))).toEqual([]);
  });
  it('a red host names the values over cpu 80, mem 85, disk 80', () => {
    expect(hostReasons(host({ red: true, cpu: 80.1, mem: 85, disk: 81 }))).toEqual([
      'cpu > 80',
      'disk > 80',
    ]);
  });
  it('a red host with every value under its line is red by age', () => {
    expect(hostReasons(host({ red: true, cpu: null }))).toEqual(['older than 3 min']);
  });
});

describe('the services red rule', () => {
  const svc = { extension: 'probe', part: 'api', calls: 9, errors: 0 };
  it('red when availability is a number under 99.0 % or p95 over 1000 ms', () => {
    expect(serviceReasons({ ...svc, availability: 0.989, p95: 10 })).toEqual(['avail < 99.0 %']);
    expect(serviceReasons({ ...svc, availability: 0.99, p95: 1000 })).toEqual([]);
    expect(serviceReasons({ ...svc, availability: 1, p95: 1001 })).toEqual(['p95 > 1000 ms']);
  });
  it('a null availability (under 50 requests) is not red', () => {
    expect(serviceReasons({ ...svc, availability: null, p95: 10 })).toEqual([]);
  });
});

describe('services from /stats', () => {
  it('one row per extension and part: sums, the worst route p95, availability over the sums', () => {
    const rows = [
      stat({ failed: 1, errors: 1 }),
      stat({ route: '/b', p95: 900 }),
      stat({ part: 'mcp', calls: 5, requests: 5 }),
    ];
    expect(row(rows)).toEqual([
      {
        extension: 'platform',
        part: 'api',
        calls: 60,
        errors: 1,
        p95: 900,
        availability: 1 - 1 / 60,
      },
      { extension: 'platform', part: 'mcp', calls: 5, errors: 0, p95: 40, availability: null },
    ]);
  });
  it('availability needs 50 requests: 49 is a dash, 50 a number', () => {
    expect(row([stat({ requests: 49 })])[0]?.availability).toBeNull();
    expect(row([stat({ requests: 50, failed: 1 })])[0]?.availability).toBe(0.98);
  });
  it('edge rows are left out: their failures are already in the page formula per extension', () => {
    const edge = stat({ part: 'edge', requests: 60, failed: 60 });
    expect(row([stat(), edge]).map(({ part }) => part)).toEqual(['api']);
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
