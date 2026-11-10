import { num, str } from './kinds.js';

// The page's section 3 questions as SQL.

const COLUMNS = `id, ts, level, kind, msg, extension, part,
  version, host, agcid, sub, session, user_type, client, method, route, status, ms, ok, fields`;

export const FILTERS = {
  q: '(positionCaseInsensitive(msg, {q:String}) > 0 OR agcid = {q:String})',
  level: 'level = {level:String}',
  extension: 'extension = {extension:String}',
  part: 'part = {part:String}',
  agcid: 'agcid = {agcid:FixedString(32)}',
  host: 'host = {host:String}',
  sub: 'sub = {sub:String}',
  route: 'route = {route:String}',
  status: 'status = {status:UInt16}',
  user_type: 'user_type = {user_type:String}',
  since: "ts >= {since:DateTime64(3, 'UTC')}",
  until: "ts < {until:DateTime64(3, 'UTC')}",
} as const;

// Newest first, or oldest first; the cursor is the (ts, id) of the last row of the page before.
export const ORDERS = {
  desc: { by: 'ts DESC, id DESC', after: '<' },
  asc: { by: 'ts ASC, id ASC', after: '>' },
} as const;
export const AFTER = (order: keyof typeof ORDERS) =>
  `(ts, id) ${ORDERS[order].after} ({cursorTs:DateTime64(3, 'UTC')}, {cursorId:UUID})`;

export const SEARCH = (where: string, order: keyof typeof ORDERS) => `SELECT ${COLUMNS} FROM events
WHERE ${where} ORDER BY ${ORDERS[order].by} LIMIT {limit:UInt32}`;

export const TRACE = `SELECT ${COLUMNS} FROM events WHERE agcid = {agcid:FixedString(32)}
ORDER BY ts, id LIMIT 1000`;

// The admin console's reliability formula; availability needs 50 requests, else null.
// One row past each cap (per part, in all) tells the caller it was cut.
// Edge routes are many: the per-part cap keeps them from crowding out the quiet routes of a part.
export const STATS_PER_PART = 200;
export const STATS_MAX = 1000;
export const STATS = (where: string) => `SELECT extension, part, kind, method, route,
  count() AS calls, countIf(level = 'error') AS errors,
  countIf((kind = 'http' AND part != 'edge' AND status >= 500) OR (kind = 'mcp' AND NOT ok)
    OR (part = 'edge' AND status IN (502, 503, 504))) AS failed,
  countIf((kind = 'http' AND part != 'edge' AND status != 429) OR kind = 'mcp'
    OR (part = 'edge' AND status IN (502, 503, 504))) AS requests,
  if(requests >= 50, 1 - failed / requests, NULL) AS availability,
  quantiles(0.5, 0.95, 0.99)(ms) AS q, uniqExact(sub) AS users
FROM events
WHERE kind IN ('http', 'mcp') AND ts >= {since:DateTime64(3, 'UTC')} AND user_type NOT IN ('test', 'service')${where}
GROUP BY extension, part, kind, method, route ORDER BY calls DESC
LIMIT ${STATS_PER_PART + 1} BY extension, part LIMIT ${STATS_MAX + 1}`;

export const HOSTS = `SELECT host,
  argMax(${num('host.cpu_pct')}, ts) AS cpu, avg(${num('host.cpu_pct')}) AS cpu1h,
  argMax(${num('host.mem_pct')}, ts) AS mem, argMax(${num('host.disk_pct')}, ts) AS disk,
  argMax(${num('host.load1')}, ts) AS load1, argMax(${num('host.containers')}, ts) AS containers,
  toString(max(ts)) AS at,
  dateDiff('second', max(ts), now()) > 180 OR cpu > 80 OR mem > 85 OR disk > 80 AS red
FROM events WHERE kind = 'event' AND fields.event.name = 'host.stats' AND ts > now() - INTERVAL 1 HOUR
GROUP BY host ORDER BY host`;

export const CONTAINERS = `SELECT ${str('agentage.container.name')} AS name,
  argMax(${num('container.cpu_pct')}, ts) AS cpu, argMax(${num('container.mem_bytes')}, ts) AS mem,
  argMax(${num('container.mem_limit')}, ts) AS \`limit\`
FROM events WHERE kind = 'event' AND fields.event.name = 'container.stats' AND host = {host:String}
  AND ts > now() - INTERVAL 5 MINUTE
GROUP BY name ORDER BY cpu DESC`;

export const ERRORS = (
  where: string
) => `SELECT ${str('exception.type')} AS type, any(msg) AS sample,
  count() AS count, toString(max(ts)) AS lastSeen, any(agcid) AS agcid
FROM events WHERE kind = 'error' AND ts >= {since:DateTime64(3, 'UTC')}${where}
GROUP BY type, ${str('agentage.fingerprint')}, normalizeQuery(msg) ORDER BY count DESC LIMIT 20`;
