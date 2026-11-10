import { createTestContext, startTestServer, type Caller } from '@agentage/extension';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EventsStore } from '../lib/store.js';
import { reads } from './reads.js';

const row = {
  id: '01a1c251-6d38-7407-ad7b-4bedc9fc47b3',
  ts: '2026-11-10 09:12:03.412',
  level: 'info',
  kind: 'http',
  msg: 'GET / 200',
  extension: 'probe',
  part: 'api',
  version: '0.6.0',
  host: 'next-1',
  agcid: 'a'.repeat(32),
  sub: null,
  session: null,
  user_type: 'agent',
  client: '',
  method: 'GET',
  route: '/',
  status: 200,
  ms: 2,
  ok: true,
  fields: {},
};
const query = vi.fn(async (): Promise<object[]> => []);
const store = { query } as unknown as EventsStore;
let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
afterEach(async () => {
  await server?.close();
  query.mockClear();
});

const get = async (path: string, caller: Caller | null) => {
  server = await startTestServer({
    create: (api) => reads(api.route, store),
    ctx: createTestContext(),
    caller,
  });
  return server.fetch(`/api/v1${path}`);
};
const as = (...scopes: string[]): Caller => ({ sub: 'usr_test', scopes });
const A = 'a'.repeat(32);
const cursor = (pair: unknown) => Buffer.from(JSON.stringify(pair)).toString('base64url');
interface Body {
  data: object[] & object;
  meta: { pagination: object };
}

describe('the read routes', () => {
  it.each([
    ['/events', 'logs:read', 403],
    [`/traces/${A}`, 'logs:read', 403],
    ['/events', 'logs:write', 403],
    [`/traces/${A}`, 'logs:write', 403],
    ['/stats', 'logs:write', 403],
    ['/stats', 'logs:read', 403],
    ['/hosts', 'logs:read', 403],
    ['/hosts/next-1/containers', 'logs:read', 403],
    ['/stats', 'logs:admin', 200],
    ['/hosts', 'logs:admin', 200],
    ['/events', 'logs:admin', 200],
    [`/traces/${A}`, 'logs:admin', 200],
    ['/hosts/next-1/containers', 'logs:admin', 200],
  ])('GET %s with %s answers %i', async (path, scope, status) => {
    expect((await get(path, as(scope))).status).toBe(status);
  });

  it.each(['/events', `/traces/${A}`, '/stats', '/hosts'])(
    'GET %s anonymous answers 401',
    async (path) => {
      expect((await get(path, null)).status).toBe(401);
    }
  );

  it('pages /events: camelCase rows, meta.pagination with a cursor when more rows exist', async () => {
    query.mockResolvedValueOnce([row, { ...row, id: 'x' }]);
    const body = (await (
      await get('/events?limit=1&level=error', as('logs:admin'))
    ).json()) as Body;
    expect(body.data[0]).toMatchObject({ ts: '2026-11-10T09:12:03.412Z', userType: 'agent' });
    expect(body.meta.pagination).toEqual({ limit: 1, nextCursor: expect.any(String) });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('level = {level:String}'),
      expect.objectContaining({ level: 'error', limit: 2 })
    );
  });

  // The kit's test caller sends no WWW-Authenticate; the real check adds scope="logs:admin".
  it.each(['logs:read', 'logs:write'])('refuses %s as FORBIDDEN, Needs logs:admin', async (s) => {
    const body = await (await get('/events', as(s))).json();
    expect(body).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Needs logs:admin' } });
  });

  it.each([
    `/events?cursor=${cursor(['x', 'y'])}`,
    `/events?cursor=${cursor([1])}`,
    '/events?cursor=bm9wZQ',
    '/events?since=yesterday',
    `/traces/xyz`,
    '/stats?window=2d',
    `/events?q=${'x'.repeat(10_240)}`,
    '/events?limit=0',
    '/events?limit=-1',
    '/events?limit=1000000000',
    '/events?since=2026-11-10T10:00:00Z&until=2026-11-01T00:00:00Z',
    `/events?agcid=${'a'.repeat(31)}`,
    `/events?agcid=${'a'.repeat(33)}`,
    `/traces/${'a'.repeat(33)}`,
    '/events?host=a%2Fb',
    '/events?host=..',
    '/hosts/a%2Fb/containers',
    '/hosts/..%2Fevents/containers',
    '/hosts/next..1/containers',
  ])('refuses %s with 400 VALIDATION_ERROR', async (path) => {
    const res = await get(path, as('logs:admin'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['/events?since=3650d', '/events?since=2016-01-01T00:00:00Z'])(
    'answers a 10-year window %s with 200: the table holds 30 days',
    async (path) => {
      expect((await get(path, as('logs:admin'))).status).toBe(200);
    }
  );

  it('answers a cursor from another query with 200, a page from that point', async () => {
    const other = cursor(['2026-11-10 09:12:03.412', row.id]);
    expect((await get(`/events?level=error&cursor=${other}`, as('logs:admin'))).status).toBe(200);
  });

  it('answers a store fault as 500 Internal error: no SQL, no store URL, no stack', async () => {
    const sql = 'Code: 62. Syntax error: SELECT id FROM events at http://logs:pw@logs_store:8123';
    query.mockRejectedValueOnce(Object.assign(new Error(sql), { code: '62' }));
    const res = await get('/events', as('logs:admin'));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: 'INTERNAL', message: 'Internal error' },
    });
    expect(text).not.toMatch(/SELECT|logs_store|pw@|at .*\.js/);
  });

  it.each([
    [
      '201 routes of one part',
      Array.from({ length: 201 }, (_, i) => ({ part: 'edge', route: `/${i}` })),
      200,
    ],
    ['1001 parts', Array.from({ length: 1001 }, (_, i) => ({ part: `p${i}`, route: '/' })), 1000],
  ])('caps /stats at %s and sets meta.truncated', async (_, rows, kept) => {
    const stat = { extension: 'x', kind: 'http', method: 'GET', calls: 1, errors: 0, failed: 0 };
    const full = rows.map((r) => ({
      ...stat,
      ...r,
      requests: 1,
      users: 0,
      availability: null,
      q: [1, 2, 3],
    }));
    query.mockResolvedValueOnce(full);
    const body = (await (await get('/stats', as('logs:admin'))).json()) as Body;
    expect(body.data).toHaveLength(kept);
    expect(body.meta).toEqual({ truncated: true });
    query.mockResolvedValueOnce(full.slice(0, 3));
    expect(((await (await get('/stats', as('logs:admin'))).json()) as Body).meta).toEqual({
      truncated: false,
    });
  });

  it('traces a known agcid: hops, ms, ok', async () => {
    query.mockResolvedValueOnce([row, { ...row, kind: 'span', ts: '2026-11-10 09:12:03.450' }]);
    const body = (await (await get(`/traces/${A}`, as('logs:admin'))).json()) as Body;
    expect(body.data).toMatchObject({ agcid: A, hops: 1, ms: 40, ok: true });
  });
});
