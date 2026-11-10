// The page's section 4 visits (S1 to S11) as lines, a few minutes old, plus two hosts.
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const A = 'a'.repeat(32);
const base = {
  level: 'info',
  version: '0.1.0',
  host: 'next-1',
  sub: null,
  session: null,
  client: 'curl',
};
const http = (s: number, extension: string, part: string, fields: object, extra = {}) => ({
  ...base,
  ts: ago(s),
  kind: 'http',
  msg: 'http',
  extension,
  part,
  agcid: A,
  user_type: 'automation',
  fields,
  ...extra,
});
const machines = (status: number, ms: number) => ({
  'http.request.method': 'GET',
  'http.route': '/api/v1/machines',
  'http.response.status_code': status,
  'agentage.duration_ms': ms,
});
const stat = (host: string, s: number, cpu: number) => ({
  ...base,
  ts: ago(s),
  kind: 'event',
  msg: `host.stats ${host}`,
  extension: 'estate',
  part: 'agent',
  host,
  agcid: null,
  user_type: 'service',
  fields: {
    'event.name': 'host.stats',
    'agentage.host.cpu_pct': cpu,
    'agentage.host.mem_pct': 61,
    'agentage.host.disk_pct': 34.1,
    'agentage.host.load1': 0.42,
    'agentage.host.containers': 2,
  },
});
const container = (name: string, cpu: number) => ({
  ...stat('next-1', 30, 0),
  msg: `container.stats ${name}`,
  fields: {
    'event.name': 'container.stats',
    'agentage.container.name': name,
    'agentage.container.cpu_pct': cpu,
    'agentage.container.mem_bytes': 181000000,
    'agentage.container.mem_limit': 536870912,
  },
});

export const AGCID = A;
export const VISITS = [
  http(300, 'platform', 'api', machines(200, 12), {
    sub: 'usr_7f3a',
    msg: 'GET /api/v1/machines 200',
  }),
  http(290, 'platform', 'api', machines(401, 1), {
    level: 'warn',
    agcid: 'b'.repeat(32),
    msg: 'GET /api/v1/machines 401',
  }),
  {
    ...http(280, 'probe', 'mcp', { 'gen_ai.tool.name': 'probe__echo', 'agentage.duration_ms': 9 }),
    kind: 'mcp',
    user_type: 'agent',
    client: 'claude-code',
    msg: 'probe__echo ok 9ms',
  },
  {
    ...http(270, 'probe', 'api', { 'exception.type': 'Error', 'exception.message': 'forced' }),
    kind: 'error',
    level: 'error',
    msg: 'Error: forced',
  },
  http(
    260,
    'probe',
    'api',
    { ...machines(500, 2), 'http.request.method': 'POST', 'http.route': '/api/v1/emit' },
    { level: 'error', msg: 'POST /api/v1/emit 500' }
  ),
  http(250, 'platform', 'edge', machines(502, 0), {
    level: 'error',
    agcid: 'c'.repeat(32),
    user_type: 'agent',
    msg: 'GET /api/v1/machines 502',
  }),
  { ...http(240, 'platform', 'store', { 'agentage.raw': true }), msg: 'LOG: checkpoint complete' },
  http(230, 'probe', 'api', machines(200, 5), { user_type: 'test', msg: 'test traffic' }),
  stat('next-1', 75, 12.4),
  stat('next-1', 600, 50),
  stat('next-2', 30, 91),
  stat('next-gw', 400, 5),
  container('platform_api.1', 3.1),
  container('root_api.1', 7.5),
];
