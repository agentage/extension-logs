import type { z } from 'zod';
import type * as O from '../lib/outputs.schema.js';

export type Host = z.output<typeof O.HostOutSchema>;
export type Stat = z.output<typeof O.StatOutSchema>;
export type Service = Pick<
  Stat,
  'extension' | 'part' | 'calls' | 'errors' | 'availability' | 'p95'
>;

const STALE_MS = 180_000;
const over = (value: number | null, max: number) => value !== null && value > max;

// Why a host row is red: a sample older than 3 min, cpu > 80, mem > 85 or disk > 80.
export const hostReasons = (h: Host, now: number): string[] =>
  [
    now - Date.parse(h.at) > STALE_MS && 'sample older than 3 min',
    over(h.cpu, 80) && 'cpu > 80',
    over(h.mem, 85) && 'mem > 85',
    over(h.disk, 80) && 'disk > 80',
  ].filter((reason): reason is string => reason !== false);

// Why a service row is red: availability a number under 99.0 % or p95 over 1000 ms.
export const serviceReasons = (s: Service): string[] =>
  [
    s.availability !== null && s.availability < 0.99 && 'availability under 99.0 %',
    s.p95 > 1000 && 'p95 over 1000 ms',
  ].filter((reason): reason is string => reason !== false);

// /stats rows are per route; a service is one extension and part, its p95 the worst route.
export const services = (rows: Stat[]): Service[] => {
  const by = new Map<string, Stat>();
  for (const r of rows) {
    const key = `${r.extension}/${r.part}`;
    const s = by.get(key);
    by.set(
      key,
      !s
        ? { ...r }
        : {
            ...s,
            ...{
              calls: s.calls + r.calls,
              errors: s.errors + r.errors,
              failed: s.failed + r.failed,
            },
            ...{ requests: s.requests + r.requests, p95: Math.max(s.p95, r.p95) },
          }
    );
  }
  return [...by.values()].map((s) => ({
    ...s,
    availability: s.requests >= 50 ? 1 - s.failed / s.requests : null,
  }));
};

export const pct = (value: number | null, digits = 1) =>
  value === null ? '-' : `${value.toFixed(digits)}%`;
export const clock = (iso: string) => iso.slice(11, 19);
