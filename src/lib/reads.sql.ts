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
  ok: 'ok = {ok:Bool}',
  name: `${str('event.name')} = {name:String}`,
  since: "ts >= {since:DateTime64(3, 'UTC')}",
  until: "ts < {until:DateTime64(3, 'UTC')}",
} as const;

// By time or by duration, ties by (ts, id); the cursor is that tuple of the page's last row.
export const KEYS = {
  ts: { ts: "{cursorTs:DateTime64(3, 'UTC')}", id: '{cursorId:UUID}' },
  ms: { ms: '{cursorMs:UInt32}', ts: "{cursorTs:DateTime64(3, 'UTC')}", id: '{cursorId:UUID}' },
} as const;
export const ORDERS = {
  desc: { dir: 'DESC', after: '<' },
  asc: { dir: 'ASC', after: '>' },
} as const;
export type SortKey = keyof typeof KEYS;
type Dir = keyof typeof ORDERS;

// The builder trusts no caller: a sort or order outside the two tables never becomes SQL.
const known = (sort: SortKey, order: Dir) => {
  if (!Object.hasOwn(KEYS, sort) || !Object.hasOwn(ORDERS, order))
    throw new Error('SEARCH: a sort or order outside the closed lists');
  return Object.entries(KEYS[sort]);
};
export const AFTER = (sort: SortKey, order: Dir) => {
  const keys = known(sort, order);
  return `(${keys.map(([k]) => k).join(', ')}) ${ORDERS[order].after} (${keys.map(([, p]) => p).join(', ')})`;
};
export const SEARCH = (where: string, order: Dir, sort: SortKey = 'ts') => {
  const by = known(sort, order).map(([k]) => `${k} ${ORDERS[order].dir}`);
  return `SELECT ${COLUMNS} FROM events
WHERE ${where} ORDER BY ${by.join(', ')} LIMIT {limit:UInt32}`;
};

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
