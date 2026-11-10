// Seeds a local `up` for the widget harness: 100 mixed lines, 5 host samples (one red), containers.
import { randomBytes } from 'node:crypto';

const BASE = process.env.LOGS_URL ?? 'http://localhost:4280';
const ISSUER = process.env.LOGS_ISSUER ?? 'http://localhost:4281';
// The rows carry real estate host names: never plant them anywhere but this machine.
for (const url of [BASE, ISSUER])
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname))
    throw new Error(`harness-seed posts to localhost or 127.0.0.1 only, not ${url}`);
const post = (url, body, token) =>
  fetch(url, {
    method: 'POST',
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
// Ingest takes a svc_ subject only; the dev issuer sets sub, the token command does not.
const minted = await post(`${ISSUER}/token`, { scope: 'logs:write', sub: 'svc_seed' });
if (!minted.ok) throw new Error(`the dev issuer at ${ISSUER} refused: ${minted.status}`);
const { token } = await minted.json();

const now = Date.now();
const ago = (s) => new Date(now - s * 1000).toISOString();
const id = () => randomBytes(16).toString('hex');
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const trace = id();
const first = (i) => (i === 0 ? trace : id());
const user = { user_type: 'user', sub: 'usr_seed', host: 'next-1', version: '0.4.0' };
const line = (at, [extension, part], kind, level, msg, agcid, fields = {}) => ({
  ...{ ...user, ts: ago(at), kind, level, msg, extension, part, agcid, fields },
});
const probe = (i, ...rest) => line(590 - i * 5, ['probe', 'api'], ...rest);
const http = (i, where, route, status, ms) => {
  const level = status >= 500 ? 'error' : 'info';
  const asked = { 'http.request.method': 'GET', 'http.route': route };
  const fields = { ...asked, 'http.response.status_code': status, 'agentage.duration_ms': ms };
  return line(600 - i * 5, where, 'http', level, `GET ${route} ${status}`, first(i), fields);
};
const mcp = (i) => ({
  ...probe(i, 'mcp', 'info', `probe__echo ok ${8 + i}ms`, first(i), {
    'gen_ai.tool.name': 'probe__echo',
    'agentage.duration_ms': 8 + i,
  }),
  ...{ part: 'mcp', user_type: 'agent', client: 'claude-code' },
});
const machines = (i) =>
  http(i, ['platform', 'api'], '/api/v1/machines', i % 30 === 7 ? 500 : 200, 20 + (i % 9) * 6);
const openapi = (i) =>
  http(i, ['probe', 'api'], '/api/v1/openapi.json', 200, i === 9 ? 1800 : 1200 + i * 10);
const forced = { 'exception.type': 'Error', 'exception.message': 'forced' };
const span = { 'agentage.span.name': 'store.query', 'agentage.duration_ms': 3 };
const lines = [
  ...many(60, machines),
  ...many(10, openapi),
  ...many(12, mcp),
  ...many(5, (i) => probe(i, 'error', 'error', 'Error: forced', first(i), forced)),
  ...many(6, (i) => probe(i, 'log', i % 3 ? 'info' : 'warn', `emit ${i}`, trace)),
  ...many(4, (i) => probe(i, 'span', 'info', 'store.query', trace, span)),
  ...many(3, (i) =>
    probe(i, 'event', 'info', 'probe.emitted', trace, { 'event.name': 'probe.emitted' })
  ),
];

const HOSTS = { 'next-gw': 22, 'next-1': 41, 'next-2': 92, 'next-data': 35, 'next-logs': 18 };
const stat = (host, name, fields) => ({
  ...{ ts: ago(20), kind: 'event', level: 'info', msg: `${name} ${host}`, extension: 'estate' },
  ...{ part: 'agent', host, user_type: 'service', fields: { 'event.name': name, ...fields } },
});
const box = (host, cpu) => (part, i) =>
  stat(host, 'container.stats', {
    'agentage.container.name': `${host}_${part}`,
    'agentage.container.cpu_pct': cpu / (i + 2),
    'agentage.container.mem_bytes': (120 + i * 40) * 1_048_576,
    'agentage.container.mem_limit': 512 * 1_048_576,
  });
const samples = Object.entries(HOSTS).flatMap(([host, cpu]) => [
  stat(host, 'host.stats', {
    'agentage.host.cpu_pct': cpu,
    'agentage.host.mem_pct': 48,
    'agentage.host.disk_pct': 37.5,
    'agentage.host.load1': cpu / 50,
    'agentage.host.containers': 3,
  }),
  ...['api', 'mcp', 'shipper'].map(box(host, cpu)),
]);

const res = await post(`${BASE}/api/v1/events`, [...lines, ...samples], token);
const { data } = await res.json();
console.log(res.status, JSON.stringify(data), `${lines.length} lines, trace agcid ${trace}`);
if (!res.ok) process.exitCode = 1;
