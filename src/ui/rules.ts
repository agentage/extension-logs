// The widgets' rows as the two reads answer them: GET /stats groups, by host or by part and route.
export interface Host {
  host: string;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  load1: number | null;
  containers: number | null;
  at: string;
}
export interface Group {
  extension: string;
  part: string;
  route?: string;
  calls: number;
  failed: number;
  requests: number;
  p95: number;
}
export interface Service {
  extension: string;
  part: string;
  calls: number;
  failed: number;
  availability: number | null;
  p95: number;
}

const over = (value: number | null, max: number) => value !== null && value > max;
const hits = (reasons: (string | false)[]) =>
  reasons.filter((reason): reason is string => reason !== false);
const STALE_MS = 180_000;

// Red past cpu 80, mem 85, disk 80, or a newest sample older than 3 min; the text names why.
export const hostReasons = (h: Host, now = Date.now()): string[] => {
  const crossed = hits([
    over(h.cpu, 80) && 'cpu > 80',
    over(h.mem, 85) && 'mem > 85',
    over(h.disk, 80) && 'disk > 80',
  ]);
  if (crossed.length > 0) return crossed;
  return now - Date.parse(h.at) > STALE_MS ? ['older than 3 min'] : [];
};

// Red when availability is a number under 99.0 % or p95 over 1000 ms.
export const serviceReasons = (s: Service): string[] =>
  hits([
    s.availability !== null && s.availability < 0.99 && 'avail < 99.0 %',
    s.p95 > 1000 && 'p95 > 1000 ms',
  ]);

const keyOf = (g: Group) => `${g.extension}/${g.part}`;
const add = (s: Group, r: Group): Group => ({
  ...s,
  calls: s.calls + r.calls,
  failed: s.failed + r.failed,
  requests: s.requests + r.requests,
});
const worst = (routes: Group[]) => {
  const p95 = new Map<string, number>();
  for (const r of routes) p95.set(keyOf(r), Math.max(p95.get(keyOf(r)) ?? 0, r.p95));
  return p95;
};

// One row per extension and part (http and mcp summed), the worst route's p95; edge rows left out.
export const services = (parts: Group[], routes: Group[]): Service[] => {
  const by = new Map<string, Group>();
  for (const r of parts.filter((row) => row.part !== 'edge')) {
    const s = by.get(keyOf(r));
    by.set(keyOf(r), s ? add(s, r) : r);
  }
  const p95 = worst(routes);
  return [...by.values()].map((s) => ({
    ...{ extension: s.extension, part: s.part, calls: s.calls, failed: s.failed },
    availability: s.requests >= 50 ? 1 - s.failed / s.requests : null,
    p95: p95.get(keyOf(s)) ?? 0,
  }));
};

interface Hop {
  ts: string;
  ms: number;
  kind: string;
  ok: boolean;
}
// A trace's header from its rows: request hops (http, mcp), first start to last end, every row ok.
export const traceHead = (events: Hop[]) => {
  const at = events.map((e) => Date.parse(e.ts));
  const start = Math.min(...events.map((e, i) => (at[i] ?? 0) - e.ms));
  const hops = events.filter((e) => e.kind === 'http' || e.kind === 'mcp').length;
  const ms = events.length > 0 ? Math.max(...at) - start : 0;
  return ` ${hops} hops · ${ms} ms · ${events.every((e) => e.ok) ? 'ok' : 'failed'}`;
};

export const pct = (value: number | null, digits = 1) =>
  value === null ? '-' : `${value.toFixed(digits)}%`;
export const clock = (iso: string) => iso.slice(11, 19);
