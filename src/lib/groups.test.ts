import { describe, expect, it } from 'vitest';
import { encodePage } from './cursor.js';
import { planOf } from './groups.js';
import { GroupsQuery, keyOf } from './groups.schema.js';
import { groupsParams, groupsSql } from './groups.sql.js';

const parse = (query: Record<string, unknown>) => GroupsQuery.safeParse(query);
const plan = (query: Record<string, unknown>) => planOf(GroupsQuery.parse(query));
const messages = (query: Record<string, unknown>) =>
  parse(query).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('the /stats builder', () => {
  it('http by route sorted on p95: the closed measures, nulls last, the keys as tie-breakers', () => {
    const sql = groupsSql(plan({ kind: 'http', by: 'route,status', sort: 'p95' }));
    expect(sql).toContain('quantile(0.95)(ms) AS `p95`');
    expect(sql).toContain('GROUP BY `route`, `status`');
    expect(sql).toContain('ORDER BY `p95` DESC NULLS LAST, `route`, `status`');
    expect(sql).toContain("user_type NOT IN ('test', 'service')");
    expect(sql).toContain('LIMIT {limit:UInt32} OFFSET {offset:UInt32}');
  });

  it('a user_type filter lifts the test and service exclusion', () => {
    const sql = groupsSql(plan({ kind: 'mcp', user_type: 'test' }));
    expect(sql).toContain('user_type = {user_type:String}');
    expect(sql).not.toContain('NOT IN');
    expect(sql).not.toContain('GROUP BY');
  });

  it('host: the newest sample without a bucket, the step average with one, oldest first', () => {
    const now = groupsSql(plan({ kind: 'host', by: 'host' }));
    expect(now).toContain('argMax(CAST(fields.agentage.host.cpu_pct');
    expect(now).toContain("fields.event.name = 'host.stats'");
    const step = groupsSql(plan({ kind: 'host', bucket: '5m' }));
    expect(step).toContain('toStartOfInterval(ts, INTERVAL 5 MINUTE)');
    expect(step).toContain('avg(CAST(fields.agentage.host.mem_pct');
    expect(step).toContain('ORDER BY `bucket` ASC NULLS LAST');
  });

  it('every value is a parameter: filters, window, one extra row, the offset', () => {
    const p = plan({ kind: 'error', by: 'type', q: "x' OR 1=1", status: '500', limit: '10' });
    expect(groupsSql(p)).not.toContain('OR 1=1');
    expect(groupsParams(p)).toMatchObject({ q: "x' OR 1=1", status: 500, limit: 11, offset: 0 });
  });

  it('throws on a hostile sort or by handed to it directly, past every schema', () => {
    const safe = plan({ kind: 'http', by: 'route' });
    const bad = [
      { ...safe, sort: 'calls; DROP TABLE events --' },
      { ...safe, by: ['route', 'route) OR 1=1 --'] },
      { ...safe, by: ['route', 'name'], sort: 'name' },
      { ...safe, bucket: '1d) --' as never },
      { ...safe, kind: 'users' as never },
    ];
    for (const p of bad) expect(() => groupsSql(p)).toThrow(/^groupsSql: /);
  });

  it('defaults: busiest first, the kind window, page 1 ends 5 s ago', () => {
    expect(plan({ kind: 'job' })).toMatchObject({ sort: 'runs', order: 'desc', limit: 100 });
    const before = Date.now();
    const until = Date.parse(`${plan({ kind: 'job' }).until.replace(' ', 'T')}Z`);
    expect(until).toBeGreaterThanOrEqual(before - 5_001);
    expect(until).toBeLessThanOrEqual(Date.now() - 5_000);
    expect(plan({ kind: 'container' }).since < plan({ kind: 'http' }).until).toBe(true);
  });
});

describe('the /stats query rules', () => {
  it.each([
    [{ kind: 'http', by: 'name' }, 'by: by takes extension, part, route'],
    [{ kind: 'http', by: 'route; DROP TABLE events' }, 'by: by takes'],
    [{ kind: 'http', by: 'route,' }, 'by: by takes'],
    [{ kind: 'http', sort: 'cpu' }, 'sort: sort takes calls, failed, requests, availability'],
    [{ kind: 'http', sort: 'calls DESC; --' }, 'sort: sort takes'],
    [{ kind: 'http', by: 'route', sort: 'status' }, 'sort: sort takes'],
    [{ kind: 'host', sort: 'bucket' }, 'sort: sort takes cpu'],
    [{ kind: 'http', bucket: '1d' }, 'bucket: '],
    [{ kind: 'http', bucket: '1m) OR 1=1 --' }, 'bucket: '],
    [{ kind: "http' OR '1'='1" }, 'kind: '],
    [{ kind: 'users' }, 'kind: '],
    [{ kind: 'http', limit: '1001' }, 'limit: '],
    [{ kind: 'http', since: '2h', until: '3h' }, 'since: since must be before until'],
    [{ kind: 'http', since: 'yesterday' }, 'since: '],
    [{ kind: 'http', since: '30d', bucket: '1m' }, 'bucket: at most 1500 steps'],
    [{ kind: 'host', since: '6d', bucket: '5m' }, 'bucket: at most 1500 steps'],
  ])('refuses %o', (query, message) => {
    expect(messages(query).join(' | ')).toContain(message);
  });

  it('takes a by column and a bucket as sort names', () => {
    expect(parse({ kind: 'error', by: 'type', sort: 'type' }).success).toBe(true);
    expect(parse({ kind: 'container', by: 'name', sort: 'name' }).success).toBe(true);
    expect(parse({ kind: 'host', bucket: '1h', sort: 'bucket' }).success).toBe(true);
    expect(parse({ kind: 'http', since: '24h', bucket: '1m' }).success).toBe(true);
    expect(parse({ kind: 'http', since: '30d', bucket: '1h' }).success).toBe(true);
  });
});

describe('the /stats cursor', () => {
  const query = { kind: 'http', by: 'route', sort: 'p95' };
  const page = (over: object) =>
    encodePage({
      o: 100,
      s: '2026-11-09 10:00:00.000',
      u: '2026-11-10 10:00:00.000',
      ...over,
    } as never);
  const key = keyOf(GroupsQuery.parse(query));

  it('carries the offset and the pinned window into page 2', () => {
    const p = plan({ ...query, cursor: page({ k: key }) });
    expect(p).toMatchObject({ offset: 100, since: '2026-11-09 10:00:00.000' });
    expect(p.until).toBe('2026-11-10 10:00:00.000');
  });

  it.each([
    [{ ...query, by: 'status' }],
    [{ ...query, kind: 'mcp' }],
    [{ ...query, sort: 'p50' }],
    [{ ...query, order: 'asc' }],
    [{ ...query, extension: 'market' }],
  ])('refuses a cursor sent with another query: %o', (other) => {
    expect(messages({ ...other, cursor: page({ k: key }) })).toEqual([
      'cursor: the cursor belongs to another query',
    ]);
  });

  it.each([
    'bm9wZQ',
    'not base64 !',
    'x'.repeat(301),
    page({ k: 'zz' }),
    page({ k: key, o: -1 }),
    page({ k: key, s: "2026-11-09' OR 1=1" }),
    page({ k: key, extra: 1 }),
    Buffer.from('[1,2]').toString('base64url'),
  ])('refuses a forged or malformed cursor %s', (cursor) => {
    expect(messages({ ...query, cursor })[0]).toMatch(/^cursor/);
  });
});
