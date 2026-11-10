import { describe, expect, it } from 'vitest';
import { encodePage } from './cursor.js';
import { eventsKey } from './events-cursor.js';
import { planOf } from './groups.js';
import { GroupsQuery, keyOf } from './groups.schema.js';
import { groupsParams, groupsSql } from './groups.sql.js';
import { AFTER, SEARCH } from './reads.sql.js';
import { SearchQuery, SearchSchema, search } from './reads.js';
import { type EventsStore } from './store.js';

const plan = (query: Record<string, unknown>) => planOf(GroupsQuery.parse(query));
const said = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
const messages = (query: Record<string, unknown>) => said(GroupsQuery.safeParse(query));
const NAME = 'name: name filters the kinds event, container and any';

describe('the 0.4 parameters of /stats', () => {
  it.each([
    [{ kind: 'http,job' }, 'kind: kind takes http, mcp'],
    [{ kind: 'any,http' }, 'only of kinds that share measures'],
    [{ kind: 'mcp,http,mcp' }, 'kind: kind takes'],
    [{ kind: 'http,mcp; DROP TABLE events' }, 'kind: kind takes'],
    [{ kind: "http,mcp' OR '1'='1" }, 'kind: kind takes'],
    [{ kind: 'http,' }, 'kind: kind takes'],
    [{ kind: 'http', by: 'kind' }, 'by: by takes'],
    [{ kind: 'log,event', by: 'type' }, 'by: by takes'],
    [{ kind: 'job', under: '100' }, 'under: under takes the kinds http and mcp'],
    [{ kind: 'http', under: '0' }, 'under: '],
    [{ kind: 'http', under: '600001' }, 'under: '],
    [{ kind: 'http', under: '1) OR 1=1 --' }, 'under: '],
    [{ kind: 'http', under: '2.5' }, 'under: '],
    [{ kind: 'http', sort: 'under' }, 'sort: sort takes'],
    [{ kind: 'http', ok: 'yes' }, 'ok: '],
    [{ kind: 'event', name: 'x'.repeat(201) }, 'name: '],
    [{ kind: 'any', sort: 'calls' }, 'sort: sort takes count, firstSeen, lastSeen'],
    ...['http', 'job', 'host', 'error', 'http,mcp'].map((kind): [object, string] => [
      { kind, name: 'x' },
      NAME,
    ]),
  ])('refuses %o', (query, message) => {
    expect(messages(query as Record<string, unknown>)).toContain(message);
  });

  it.each([
    { kind: 'http,mcp', by: 'kind,route', under: '300', sort: 'under' },
    { kind: 'log,event', by: 'kind' },
    { kind: 'event,log', by: 'kind,name', name: 'backup.run' },
    { kind: 'any', by: 'kind,name', name: 'backup.run' },
    { kind: 'container', name: 'gaps_api.1' },
    { kind: 'error', by: 'fingerprint' },
    { kind: 'event', by: 'name', name: 'backup.run' },
    { kind: 'host', sort: 'disk_max' },
    { kind: 'container', sort: 'mem_max' },
    { kind: 'http', since: '30d', bucket: '1d' },
  ])('takes %o', (query) => {
    expect(messages(query)).toBe('');
  });

  it('one order per list: mcp,http is http,mcp, with one cursor key', () => {
    const [a, b] = ['http,mcp', 'mcp,http'].map((kind) => GroupsQuery.parse({ kind }));
    expect(b?.kind).toBe('http,mcp');
    expect(keyOf(a!)).toBe(keyOf(b!));
  });

  it('a list ORs the members of the closed table; values stay parameters', () => {
    const p = plan({ kind: 'http,mcp', by: 'kind', under: '300', ok: 'false' });
    const sql = groupsSql(p);
    expect(sql).toContain("(kind = 'http' OR kind = 'mcp')");
    expect(sql).toContain('countIf(ms <= {under:UInt32})');
    expect(sql).toContain('ok = {ok:Bool}');
    expect(groupsParams(p)).toMatchObject({ under: 300, ok: false });
  });

  it('name filters what by=name groups: the container name, the event name', () => {
    const box = plan({ kind: 'container', name: "x' OR 1=1" });
    expect(groupsSql(box)).toContain('fields.agentage.container.name, ');
    expect(groupsSql(box)).toContain('= {name:String}');
    expect(groupsSql(box)).not.toContain('OR 1=1');
    expect(groupsParams(box)).toMatchObject({ name: "x' OR 1=1" });
    expect(groupsSql(plan({ kind: 'any', name: 'b' }))).toContain('fields.event.name, ');
  });

  it('throws on a hostile kind, sort, order, by or name handed to it directly', () => {
    const safe = plan({ kind: 'http', by: 'route' });
    const bad = [
      { ...safe, kind: "http,mcp') OR 1=1 --" },
      { ...safe, kind: 'http,job' },
      { ...safe, sort: 'under' },
      { ...safe, order: 'desc; DROP TABLE events --' as never },
      { ...safe, by: ['kind'] },
      { ...safe, by: ['fingerprint'] },
      { ...safe, filters: { name: 'x' } },
    ];
    for (const p of bad) expect(() => groupsSql(p)).toThrow(/^groupsSql: /);
  });

  it.each([{ under: '301' }, { kind: 'http' }, { ok: 'true' }, { by: 'kind' }])(
    'refuses a cursor sent with another %o',
    (other) => {
      const query = { kind: 'mcp,http', by: 'route', under: '300', ok: 'false' };
      const k = keyOf(GroupsQuery.parse(query));
      const page = { o: 1, s: '2026-11-09 10:00:00.000', u: '2026-11-10 10:00:00.000', k };
      const cursor = encodePage(page);
      expect(messages({ ...query, kind: 'http,mcp', cursor })).toBe('');
      expect(messages({ ...query, ...other, cursor })).toBe(
        'cursor: the cursor belongs to another query'
      );
    }
  );
});

describe('the 0.4 parameters of /events', () => {
  const at = { t: '2026-11-10 09:12:03.412', i: '01a1c251-6d38-7407-ad7b-4bedc9fc47b3' };
  const ms = { sort: 'ms', kind: 'http' };
  const k = eventsKey(SearchSchema.parse(ms));
  const cursor = (page: unknown) => Buffer.from(JSON.stringify(page)).toString('base64url');
  const refused = (query: Record<string, unknown>) => said(SearchQuery.safeParse(query));

  it('sort=ms orders by (ms, ts, id) and pages after that tuple', () => {
    expect(SEARCH('1', 'desc', 'ms')).toContain('ORDER BY ms DESC, ts DESC, id DESC');
    expect(AFTER('ms', 'asc')).toBe(
      "(ms, ts, id) > ({cursorMs:UInt32}, {cursorTs:DateTime64(3, 'UTC')}, {cursorId:UUID})"
    );
  });

  it('throws on a sort, order or name handed to the builder outside its tables', () => {
    expect(() => SEARCH('1', 'desc', 'ms; DROP TABLE events' as never)).toThrow(/^SEARCH: /);
    expect(() => AFTER('ts', 'up' as never)).toThrow(/^SEARCH: /);
    const store = { query: async () => [] } as unknown as EventsStore;
    const input = { ...SearchSchema.parse({}), kind: 'http' as const, name: 'x' };
    return expect(search(store, input)).rejects.toThrow(/^search: /);
  });

  it.each([
    [{ ...ms, cursor: cursor({ ...at, m: 40, k }) }, ''],
    [{ ...ms, cursor: cursor({ ...at, k }) }, 'cursor: the cursor belongs to another query'],
    [{ ...ms, order: 'asc', cursor: cursor({ ...at, m: 40, k }) }, 'cursor: the cursor belongs'],
    [{ ...ms, kind: 'mcp', cursor: cursor({ ...at, m: 40, k }) }, 'cursor: the cursor belongs'],
    [{ ...ms, status: '500', cursor: cursor({ ...at, m: 40, k }) }, 'cursor: the cursor belongs'],
    [{ ...ms, cursor: cursor({ ...at, m: -1, k }) }, 'cursor'],
    [{ ...ms, cursor: cursor({ ...at, m: '1) OR 1=1', k }) }, 'cursor'],
    [{ ...ms, cursor: cursor([at.t, at.i, 40]) }, 'cursor'],
    [{ sort: 'ms DESC; --' }, 'sort: '],
    [{ ok: '1 OR 1=1' }, 'ok: '],
    [{ kind: 'http', name: 'x' }, NAME],
    [{ kind: 'host', name: 'x' }, NAME],
    [{ kind: 'container', name: 'gaps_api.1' }, ''],
    [{ name: 'backup.run' }, ''],
  ])('%o: %s', (query, message) => {
    if (message === '') expect(refused(query)).toBe('');
    else expect(refused(query)).toContain(message);
  });
});
