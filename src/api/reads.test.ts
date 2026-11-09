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
afterEach(() => server?.close());

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
  ])('refuses %s with 400', async (path) => {
    expect((await get(path, as('logs:admin'))).status).toBe(400);
  });

  it('traces a known agcid: hops, ms, ok', async () => {
    query.mockResolvedValueOnce([row, { ...row, kind: 'span', ts: '2026-11-10 09:12:03.450' }]);
    const body = (await (await get(`/traces/${A}`, as('logs:admin'))).json()) as Body;
    expect(body.data).toMatchObject({ agcid: A, hops: 1, ms: 40, ok: true });
  });
});
