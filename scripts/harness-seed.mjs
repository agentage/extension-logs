// Seeds a local `up` for the widget harness: 100 mixed lines, 5 host samples (one red), containers.
import { randomBytes } from 'node:crypto';

const BASE = process.env.LOGS_URL ?? 'http://localhost:4280';
const ISSUER = process.env.LOGS_ISSUER ?? 'http://localhost:4281';
// The rows carry real estate host names: never plant them anywhere but this machine.
for (const url of [BASE, ISSUER])
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname))
    throw new Error(`harness-seed posts to localhost or 127.0.0.1 only, not ${url}`);
// Ingest takes a svc_ subject only; the dev issuer sets sub, the token command does not.
const minted = await fetch(`${ISSUER}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'logs:write', sub: 'svc_seed' }),
});
if (!minted.ok) throw new Error(`the dev issuer at ${ISSUER} refused: ${minted.status}`);
const { token } = await minted.json();

const now = Date.now();
const ago = (s) => new Date(now - s * 1000).toISOString();
const id = () => randomBytes(16).toString('hex');
const user = { user_type: 'user', sub: 'usr_seed', host: 'next-1', version: '0.2.0' };
const http = (i, part, route, status, ms, agcid = id()) => ({
  ...user,
  ts: ago(600 - i * 5),
  kind: 'http',
  level: status >= 500 ? 'error' : 'info',
  msg: `GET ${route} ${status}`,
  extension: part[0],
  part: part[1],
  agcid,
  fields: {
    'http.request.method': 'GET',
    'http.route': route,
    'http.response.status_code': status,
    'agentage.duration_ms': ms,
  },
});
const line = (i, kind, level, msg, agcid, fields = {}) => ({
  ...user,
  ts: ago(590 - i * 5),
  kind,
  level,
  msg,
  extension: 'probe',
  part: 'api',
  agcid,
  fields,
});

const trace = id();
const lines = [
  ...Array.from({ length: 60 }, (_, i) =>
    http(
      i,
      ['platform', 'api'],
      '/api/v1/machines',
      i % 30 === 7 ? 500 : 200,
      20 + (i % 9) * 6,
      i === 0 ? trace : undefined
    )
  ),
  ...Array.from({ length: 10 }, (_, i) =>
    http(
      i,
      ['probe', 'api'],
      '/api/v1/openapi.json',
      200,
      i === 9 ? 1800 : 1200 + i * 10,
      i === 0 ? trace : undefined
    )
  ),
  ...Array.from({ length: 12 }, (_, i) => ({
    ...line(i, 'mcp', 'info', `probe__echo ok ${8 + i}ms`, i === 0 ? trace : id(), {
      'gen_ai.tool.name': 'probe__echo',
      'agentage.duration_ms': 8 + i,
    }),
    part: 'mcp',
    user_type: 'agent',
    client: 'claude-code',
  })),
  ...Array.from({ length: 5 }, (_, i) =>
    line(i, 'error', 'error', 'Error: forced', i === 0 ? trace : id(), {
      'exception.type': 'Error',
      'exception.message': 'forced',
    })
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    line(i, 'log', i % 3 ? 'info' : 'warn', `emit ${i}`, trace)
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    line(i, 'span', 'info', 'store.query', trace, {
      'agentage.span.name': 'store.query',
      'agentage.duration_ms': 3,
    })
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    line(i, 'event', 'info', 'probe.emitted', trace, { 'event.name': 'probe.emitted' })
  ),
];

const HOSTS = [
  ['next-gw', 22],
  ['next-1', 41],
  ['next-2', 92],
  ['next-data', 35],
  ['next-logs', 18],
];
const stat = (host, name, fields) => ({
  ts: ago(20),
  kind: 'event',
  level: 'info',
  msg: `${name} ${host}`,
  extension: 'estate',
  part: 'agent',
  host,
  user_type: 'service',
  fields: { 'event.name': name, ...fields },
});
const samples = HOSTS.flatMap(([host, cpu]) => [
  stat(host, 'host.stats', {
    'agentage.host.cpu_pct': cpu,
    'agentage.host.mem_pct': 48,
    'agentage.host.disk_pct': 37.5,
    'agentage.host.load1': cpu / 50,
    'agentage.host.containers': 3,
  }),
  ...['api', 'mcp', 'shipper'].map((part, i) =>
    stat(host, 'container.stats', {
      'agentage.container.name': `${host}_${part}`,
      'agentage.container.cpu_pct': cpu / (i + 2),
      'agentage.container.mem_bytes': (120 + i * 40) * 1_048_576,
      'agentage.container.mem_limit': 512 * 1_048_576,
    })
  ),
]);

const res = await fetch(`${BASE}/api/v1/events`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([...lines, ...samples]),
});
console.log(
  res.status,
  JSON.stringify((await res.json()).data),
  `${lines.length} lines, trace agcid ${trace}`
);
if (!res.ok) process.exitCode = 1;
