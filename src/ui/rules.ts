import type { z } from 'zod';
import type * as O from '../lib/outputs.schema.js';

export type Host = z.output<typeof O.HostOutSchema>;
export type Stat = z.output<typeof O.StatOutSchema>;
export type Service = Pick<
  Stat,
  'extension' | 'part' | 'calls' | 'errors' | 'availability' | 'p95'
>;

const over = (value: number | null, max: number) => value !== null && value > max;
const hits = (reasons: (string | false)[]) =>
  reasons.filter((reason): reason is string => reason !== false);

// The api decides red (HOSTS in reads.sql.ts); the text names the values that crossed, else the age.
export const hostReasons = (h: Host): string[] => {
  if (!h.red) return [];
  const crossed = hits([
    over(h.cpu, 80) && 'cpu > 80',
    over(h.mem, 85) && 'mem > 85',
    over(h.disk, 80) && 'disk > 80',
  ]);
  return crossed.length > 0 ? crossed : ['older than 3 min'];
};

// Red when availability is a number under 99.0 % or p95 over 1000 ms.
export const serviceReasons = (s: Service): string[] =>
  hits([
    s.availability !== null && s.availability < 0.99 && 'avail < 99.0 %',
    s.p95 > 1000 && 'p95 > 1000 ms',
  ]);

const add = (s: Stat, r: Stat): Stat => ({
  ...s,
  calls: s.calls + r.calls,
  errors: s.errors + r.errors,
  failed: s.failed + r.failed,
  requests: s.requests + r.requests,
  p95: Math.max(s.p95, r.p95),
});

// One row per extension and part; edge rows are left out, the page formula counts them per extension.
export const services = (rows: Stat[]): Service[] => {
  const by = new Map<string, Stat>();
  for (const r of rows.filter((row) => row.part !== 'edge')) {
    const key = `${r.extension}/${r.part}`;
    const s = by.get(key);
    by.set(key, s ? add(s, r) : r);
  }
  return [...by.values()].map((s) => ({
    ...s,
    availability: s.requests >= 50 ? 1 - s.failed / s.requests : null,
  }));
};

export const pct = (value: number | null, digits = 1) =>
  value === null ? '-' : `${value.toFixed(digits)}%`;
export const clock = (iso: string) => iso.slice(11, 19);
