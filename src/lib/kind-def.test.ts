import { describe, expect, it } from 'vitest';
import { encodePage } from './cursor.js';
import { planOf } from './groups.js';
import { GroupsQuery, keyOf } from './groups.schema.js';
import { groupsParams, groupsSql } from './groups.sql.js';
import { AFTER, SEARCH } from './reads.sql.js';
import { SearchQuery } from './reads.js';

const plan = (query: Record<string, unknown>) => planOf(GroupsQuery.parse(query));
const messages = (query: Record<string, unknown>) =>
  GroupsQuery.safeParse(query).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('the 0.4 parameters of /stats', () => {
  it.each([
    [{ kind: 'http,job' }, 'kind: http and job have different measures'],
    [{ kind: 'any,http' }, 'kind: any and http have different measures'],
    [{ kind: 'http,mcp; DROP TABLE events' }, 'kind: kind takes http, mcp'],
    [{ kind: "http,mcp' OR '1'='1" }, 'kind: kind takes'],
    [{ kind: 'http,' }, 'kind: kind takes'],
    [{ kind: 'http', by: 'kind' }, 'by: by takes'],
    [{ kind: 'event,log', by: 'name' }, 'by: by takes'],
    [{ kind: 'job', under: '100' }, 'under: under takes the kinds http and mcp'],
    [{ kind: 'http', under: '0' }, 'under: '],
    [{ kind: 'http', under: '600001' }, 'under: '],
    [{ kind: 'http', under: '1) OR 1=1 --' }, 'under: '],
    [{ kind: 'http', under: '2.5' }, 'under: '],
    [{ kind: 'http', sort: 'under' }, 'sort: sort takes'],
    [{ kind: 'http', ok: 'yes' }, 'ok: '],
    [{ kind: 'event', name: 'x'.repeat(201) }, 'name: '],
    [{ kind: 'any', sort: 'calls' }, 'sort: sort takes count, firstSeen, lastSeen'],
  ])('refuses %o', (query, message) => {
    expect(messages(query).join(' | ')).toContain(message);
  });

  it.each([
    { kind: 'http,mcp', by: 'kind,route', under: '300', sort: 'under' },
    { kind: 'mcp,http,mcp' },
    { kind: 'log,event', by: 'kind' },
    { kind: 'event,log', by: 'kind,extension' },
    { kind: 'any', by: 'kind', sort: 'lastSeen' },
    { kind: 'error', by: 'fingerprint' },
    { kind: 'event', by: 'name', name: 'backup.run' },
    { kind: 'host', sort: 'disk_max' },
    { kind: 'container', sort: 'mem_max' },
    { kind: 'http', since: '30d', bucket: '1d' },
  ])('takes %o', (query) => {
    expect(messages(query)).toEqual([]);
  });

  it('a list ORs the members of the closed table; values stay parameters', () => {
    const p = plan({ kind: 'http,mcp', by: 'kind', under: '300', name: "x' OR 1=1", ok: 'false' });
    const sql = groupsSql(p);
    expect(sql).toContain("(kind = 'http' OR kind = 'mcp')");
    expect(sql).toContain('countIf(ms <= {under:UInt32})');
    expect(sql).toContain('ok = {ok:Bool}');
    expect(sql).not.toContain('OR 1=1');
    expect(groupsParams(p)).toMatchObject({ under: 300, ok: false, name: "x' OR 1=1" });
  });

  it('throws on a hostile kind, sort or by handed to it directly, past every schema', () => {
    const safe = plan({ kind: 'http', by: 'route' });
    const bad = [
      { ...safe, kind: "http,mcp') OR 1=1 --" },
      { ...safe, kind: 'http,job' },
      { ...safe, sort: 'under' },
      { ...safe, by: ['kind'] },
      { ...safe, by: ['fingerprint'] },
      { ...safe, kind: 'log,event', by: ['name'] },
    ];
    for (const p of bad) expect(() => groupsSql(p)).toThrow(/^groupsSql: /);
  });

  it.each([
    { under: '301' },
    { kind: 'mcp,http' },
    { name: 'deploy.run' },
    { ok: 'true' },
    { by: 'kind,user_type' },
  ])('refuses a cursor sent with another %o', (other) => {
    const query = { kind: 'http,mcp', by: 'kind', under: '300', name: 'backup.run' };
    const k = keyOf(GroupsQuery.parse(query));
    const cursor = encodePage({
      o: 1,
      s: '2026-11-09 10:00:00.000',
      u: '2026-11-10 10:00:00.000',
      k,
    });
    expect(messages({ ...query, cursor })).toEqual([]);
    expect(messages({ ...query, ...other, cursor })).toEqual([
      'cursor: the cursor belongs to another query',
    ]);
  });
});

describe('the 0.4 parameters of /events', () => {
  const at = ['2026-11-10 09:12:03.412', '01a1c251-6d38-7407-ad7b-4bedc9fc47b3'];
  const cursor = (tuple: unknown[]) => Buffer.from(JSON.stringify(tuple)).toString('base64url');

  it('sort=ms orders by (ms, ts, id) and pages after that tuple', () => {
    expect(SEARCH('1', 'desc', 'ms')).toContain('ORDER BY ms DESC, ts DESC, id DESC');
    expect(AFTER('ms', 'asc')).toBe(
      "(ms, ts, id) > ({cursorMs:UInt32}, {cursorTs:DateTime64(3, 'UTC')}, {cursorId:UUID})"
    );
  });

  it('throws on a sort or order handed to the builder outside its tables', () => {
    expect(() => SEARCH('1', 'desc', 'ms; DROP TABLE events' as never)).toThrow(/^SEARCH: /);
    expect(() => AFTER('ts', 'up' as never)).toThrow(/^SEARCH: /);
  });

  it.each([
    [{ sort: 'ms', cursor: cursor(at) }, 'cursor: the cursor belongs to another sort'],
    [{ cursor: cursor([...at, 40]) }, 'cursor: the cursor belongs to another sort'],
    [{ sort: 'ms', cursor: cursor([...at, -1]) }, 'cursor'],
    [{ sort: 'ms', cursor: cursor([...at, '1) OR 1=1']) }, 'cursor'],
    [{ sort: 'ms DESC; --' }, 'sort: '],
    [{ ok: '1 OR 1=1' }, 'ok: '],
  ])('refuses %o', (query, message) => {
    const issues = SearchQuery.safeParse(query).error?.issues ?? [];
    expect(issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')).toContain(message);
  });

  it('takes an ms cursor with sort=ms', () => {
    expect(SearchQuery.safeParse({ sort: 'ms', cursor: cursor([...at, 40]) }).success).toBe(true);
  });
});
