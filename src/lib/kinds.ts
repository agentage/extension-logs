import { KINDS } from '@agentage/extension/logs';

// JSON paths are cast: ClickHouse refuses Dynamic in avg and GROUP BY.
export const num = (path: string) => `CAST(fields.agentage.${path}, 'Nullable(Float64)')`;
export const str = (path: string) => `ifNull(CAST(fields.${path}, 'Nullable(String)'), '')`;

// A measure's SQL, or its SQL without and with a bucket (a sample: the newest, or the step's average).
export type Measure = string | { now: string; step: string };
export interface KindDef {
  where: string;
  measures: Record<string, Measure>;
  by?: Record<string, string>;
  sort: string;
  since: string;
  // Tests and services are left out unless the call names a user_type.
  synthetic?: true;
}

export const GROUP_KINDS = [...KINDS, 'host', 'container'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export const BUCKETS = {
  '1m': 'INTERVAL 1 MINUTE',
  '5m': 'INTERVAL 5 MINUTE',
  '1h': 'INTERVAL 1 HOUR',
};
export type Bucket = keyof typeof BUCKETS;
export const BUCKET_MS: Record<Bucket, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };
// One call draws at most this many time steps (30 d of 1h, 5 d of 5m, 24 h of 1m).
export const MAX_STEPS = 1500;
export const COLUMNS = [
  ...['extension', 'part', 'route', 'method', 'status', 'host', 'level'],
  ...['client', 'user_type', 'sub', 'version'],
] as const;

const latency = { p50: 'quantile(0.5)(ms)', p95: 'quantile(0.95)(ms)', p99: 'quantile(0.99)(ms)' };
// The admin console's formula: at the edge only 502, 503, 504 count; a 429 is no request.
const EDGE = "part = 'edge'";
const GATEWAY = 'status IN (502, 503, 504)';
const reliability = (failed: string, requests: string) => ({
  calls: 'count()',
  failed: `countIf(${failed})`,
  requests,
  availability: 'if(requests >= 50, 1 - failed / requests, NULL)',
  ...latency,
  users: 'uniqExact(sub)',
});
const sample = (path: string): Measure => ({
  now: `argMax(${num(path)}, ts)`,
  step: `avg(${num(path)})`,
});
const cpu = (path: string) => ({
  cpu: sample(path),
  cpu_avg: `avg(${num(path)})`,
  cpu_max: `max(${num(path)})`,
});
const named = (event: string) => `kind = 'event' AND fields.event.name = '${event}'`;
const counted = (kind: string): KindDef => ({
  ...{ where: `kind = '${kind}'`, measures: { count: 'count()' }, sort: 'count', since: '24h' },
});

export const KIND_DEFS: Record<GroupKind, KindDef> = {
  http: {
    where: "kind = 'http'",
    measures: reliability(
      `if(${EDGE}, ${GATEWAY}, status >= 500)`,
      `countIf(if(${EDGE}, ${GATEWAY}, status != 429))`
    ),
    ...{ sort: 'calls', since: '24h', synthetic: true },
  },
  mcp: {
    where: "kind = 'mcp'",
    measures: reliability('NOT ok', 'count()'),
    ...{ sort: 'calls', since: '24h', synthetic: true },
  },
  job: {
    where: "kind = 'job'",
    measures: { runs: 'count()', failed: 'countIf(NOT ok)', p50: latency.p50, p95: latency.p95 },
    ...{ sort: 'runs', since: '24h' },
  },
  span: { ...counted('span'), measures: { count: 'count()', ...latency } },
  error: {
    ...counted('error'),
    by: { type: str('exception.type') },
    measures: { count: 'count()', lastSeen: 'max(ts)', sample: 'any(msg)', agcid: 'any(agcid)' },
  },
  log: counted('log'),
  event: counted('event'),
  host: {
    where: named('host.stats'),
    measures: {
      ...cpu('host.cpu_pct'),
      ...{ mem: sample('host.mem_pct'), disk: sample('host.disk_pct') },
      ...{ load1: sample('host.load1'), containers: sample('host.containers'), at: 'max(ts)' },
    },
    ...{ sort: 'cpu', since: '1h' },
  },
  container: {
    where: named('container.stats'),
    by: { name: str('agentage.container.name') },
    measures: {
      ...cpu('container.cpu_pct'),
      ...{ mem: sample('container.mem_bytes'), limit: sample('container.mem_limit') },
      at: 'max(ts)',
    },
    ...{ sort: 'cpu', since: '5m' },
  },
};

// The names a caller may group on, and the names it may sort on, for one kind.
export const byNames = (kind: GroupKind) => [...COLUMNS, ...Object.keys(KIND_DEFS[kind].by ?? {})];
export const sortNames = (kind: GroupKind, by: string[], bucket: boolean) => [
  ...Object.keys(KIND_DEFS[kind].measures),
  ...by,
  ...(bucket ? ['bucket'] : []),
];
