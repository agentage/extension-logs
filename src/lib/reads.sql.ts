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
