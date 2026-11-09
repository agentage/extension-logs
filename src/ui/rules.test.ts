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

const NOW = Date.parse('2026-11-09T22:00:00.000Z');
const host = (over: Partial<Host> = {}): Host => ({
  ...{ host: 'next-1', cpu: 20, cpu1h: 18, mem: 50, disk: 40, load1: 0.4, containers: 3 },
  ...{ at: '2026-11-09T21:59:30.000Z', red: false, ...over },
});
const stat = (over: Partial<Stat> = {}): Stat => ({
  ...{ extension: 'platform', part: 'api', kind: 'http', method: 'GET', route: '/a' },
  ...{ calls: 60, errors: 0, failed: 0, requests: 60, users: 1 },
  ...{ availability: 1, p50: 10, p95: 40, p99: 90, ...over },
});

describe('the hosts red rule', () => {
  it('a fresh sample under every threshold is not red', () => {
    expect(hostReasons(host(), NOW)).toEqual([]);
  });
  it('red when the sample is older than 3 min, cpu > 80, mem > 85 or disk > 80', () => {
    expect(hostReasons(host({ at: '2026-11-09T21:56:59.000Z' }), NOW)).toEqual([
      'sample older than 3 min',
    ]);
    expect(hostReasons(host({ at: '2026-11-09T21:57:00.000Z' }), NOW)).toEqual([]);
    expect(hostReasons(host({ cpu: 80.1 }), NOW)).toEqual(['cpu > 80']);
    expect(hostReasons(host({ cpu: 80, mem: 85, disk: 80 }), NOW)).toEqual([]);
    expect(hostReasons(host({ mem: 86, disk: 81 }), NOW)).toEqual(['mem > 85', 'disk > 80']);
  });
  it('a missing value is not red', () => {
    expect(hostReasons(host({ cpu: null, mem: null, disk: null }), NOW)).toEqual([]);
  });
});

describe('the services red rule', () => {
  const svc = { extension: 'probe', part: 'api', calls: 9, errors: 0 };
  it('red when availability is a number under 99.0 % or p95 over 1000 ms', () => {
    expect(serviceReasons({ ...svc, availability: 0.989, p95: 10 })).toEqual([
      'availability under 99.0 %',
    ]);
    expect(serviceReasons({ ...svc, availability: 0.99, p95: 1000 })).toEqual([]);
    expect(serviceReasons({ ...svc, availability: 1, p95: 1001 })).toEqual(['p95 over 1000 ms']);
  });
  it('a null availability (under 50 requests) is not red', () => {
    expect(serviceReasons({ ...svc, availability: null, p95: 10 })).toEqual([]);
  });
});

describe('services from /stats', () => {
  it('one row per extension and part: sums, the worst p95, availability over the sums', () => {
    const rows = [
      stat({ failed: 1, errors: 1, p95: 40 }),
      stat({ route: '/b', p95: 900 }),
      stat({ part: 'mcp', calls: 5, requests: 5 }),
    ];
    expect(
      services(rows).map(({ extension, part, calls, errors, p95, availability }) => ({
        extension,
        part,
        calls,
        errors,
        p95,
        availability,
      }))
    ).toEqual([
      {
        extension: 'platform',
        part: 'api',
        calls: 120,
        errors: 1,
        p95: 900,
        availability: 1 - 1 / 120,
      },
      { extension: 'platform', part: 'mcp', calls: 5, errors: 0, p95: 40, availability: null },
    ]);
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
