// Rows for the 0.4 additions: one extension, fixed times ten minutes back, a second apart.
const T0 = Date.now() - 600_000;
export const at = (i: number) => new Date(T0 + i * 1000).toISOString();
export const G = 'f'.repeat(32);
const line = (i: number, kind: string, fields: object, extra: object = {}) => ({
  ...{ ts: at(i), level: 'info', kind, msg: `${kind} ${i}`, extension: 'gaps', part: 'api' },
  ...{ user_type: 'user', sub: 'usr_a', host: 'next-1', fields },
  ...extra,
});
const http = (i: number, route: string, ms: number, status = 200, extra: object = {}) =>
  line(
    i,
    'http',
    {
      ...{ 'http.request.method': 'GET', 'http.route': route },
      ...{ 'http.response.status_code': status, 'agentage.duration_ms': ms },
    },
    extra
  );
const mcp = (i: number, ms: number, sub: string, error?: string) =>
  line(
    i,
    'mcp',
    {
      ...{ 'gen_ai.tool.name': 'gaps__t', 'agentage.duration_ms': ms },
      ...(error && { 'error.type': error }),
    },
    { part: 'mcp', sub }
  );
const stat = (i: number, name: string, fields: object) =>
  line(i, 'event', { 'event.name': name, ...fields }, { user_type: 'service', host: 'gaps-h' });

// http /a: 10 20 30 40 ms, one 500; /b: one row of 5 ms; a test and a service row of /a.
export const GAPS = [
  http(0, '/a', 10, 200, { agcid: G }),
  http(1, '/a', 20, 200, { sub: 'usr_b' }),
  http(2, '/a', 30),
  http(3, '/a', 40, 500, { level: 'error' }),
  http(4, '/b', 5),
  http(5, '/a', 50, 200, { user_type: 'test' }),
  http(6, '/a', 60, 200, { user_type: 'service' }),
  mcp(7, 100, 'usr_a'),
  mcp(8, 200, 'usr_c', 'Error'),
  ...['fp1', 'fp1', 'fp2'].map((fp, n) =>
    line(9 + n, 'error', { 'exception.type': 'Error', 'agentage.fingerprint': fp })
  ),
  stat(12, 'backup.run', { 'backup.status': 'ok' }),
  stat(13, 'backup.run', { 'backup.status': 'ok' }),
  stat(14, 'deploy.run', {}),
  ...[10, 20, 25].map((cpu, n) =>
    stat(15 + n, 'host.stats', {
      ...{ 'agentage.host.cpu_pct': cpu, 'agentage.host.mem_pct': 40 + n * 15 },
      'agentage.host.disk_pct': 10 + n * 5,
    })
  ),
  ...[300, 900, 500].map((bytes, n) =>
    stat(18 + n, 'container.stats', {
      ...{ 'agentage.container.name': 'gaps_api.1', 'agentage.container.mem_bytes': bytes },
      'agentage.container.cpu_pct': 1,
    })
  ),
];
// Five rows with one ms and one ts: only the id breaks their tie.
export const TIES = Array.from({ length: 5 }, (_, n) =>
  http(30, '/tie', 7, 200, { extension: 'ties', msg: `tie ${n}` })
);
// The union rule: an api 429 is no request, an edge 404 neither, an edge 502 fails, as an mcp error.
export const UNION = [
  ...[200, 429, 500].map((status, n) => http(40 + n, '/u', 10, status, { extension: 'union' })),
  ...[502, 404].map((status) => http(43, '/u', 0, status, { extension: 'union', part: 'edge' })),
  ...[mcp(44, 10, 'usr_a'), mcp(45, 10, 'usr_a', 'Error')].map((row) => ({
    ...row,
    extension: 'union',
  })),
];
