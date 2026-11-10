import { createTestContext, startTestServer, type Caller } from '@agentage/extension';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorOf } from '../lib/events-cursor.js';
import { SearchSchema } from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';
import { reads } from './reads.js';

// The two reads at the route: the groups form of /stats and the new /events parameters.
const query = vi.fn(async (): Promise<object[]> => []);
const store = { query } as unknown as EventsStore;
let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
afterEach(async () => {
  await server?.close();
  query.mockClear();
});
const admin: Caller = { sub: 'usr_test', scopes: ['logs:admin'] };
const get = async (path: string) => {
  server = await startTestServer({
    create: (api) => reads(api.route, store),
    ctx: createTestContext(),
    caller: admin,
  });
  return server.fetch(`/api/v1${path}`);
};
interface Body {
  data: Record<string, unknown>[];
  meta: Record<string, unknown>;
  error: { code: string; message: string; details: { field: string; message: string }[] };
}
const body = async (path: string) => (await (await get(path)).json()) as Body;
const forged = Buffer.from(
  JSON.stringify({
    o: 1,
    s: '2026-11-09 10:00:00.000',
    u: '2026-11-10 10:00:00.000',
    k: '0'.repeat(16),
  })
).toString('base64url');

describe('GET /stats with kind', () => {
  it('answers groups with meta: kind, by, sort, order, since, truncated, nextCursor', async () => {
    query.mockResolvedValueOnce([
      { status: 200, calls: 3, bucket: '2026-11-10 14:00:00.000' },
      { status: 404, calls: 1, bucket: '2026-11-10 14:00:00.000' },
    ]);
    const { data, meta } = await body('/stats?kind=http&by=status&extension=market&limit=1');
    expect(data).toEqual([{ status: 200, calls: 3, bucket: '2026-11-10T14:00:00.000Z' }]);
    expect(meta).toEqual({
      ...{ kind: 'http', by: ['status'], sort: 'calls', order: 'desc', since: '24h' },
      ...{ truncated: true, nextCursor: expect.any(String) },
    });
  });

  it('a call without kind keeps the window form and its answer', async () => {
    await get('/stats?window=15m&by=bogus&sort=bogus');
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT 201 BY extension, part'),
      expect.objectContaining({ since: expect.any(String) })
    );
    expect((await get('/stats?window=2d')).status).toBe(400);
  });

  it('window with kind answers 400: window is the form without kind', async () => {
    const { error } = await body('/stats?kind=http&window=24h');
    expect(error.details).toEqual([
      { field: 'window', message: expect.stringMatching(/use since/) },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('a bucket past 1500 steps answers 400 before the store', async () => {
    const { error } = await body('/stats?kind=http&since=30d&bucket=1m');
    expect(error.details[0]?.field).toBe('bucket');
    expect(query).not.toHaveBeenCalled();
  });

  it('a list of kinds that measure differently answers 400 naming the lists it takes', async () => {
    const { error } = await body('/stats?kind=http,job');
    expect(error.details).toEqual([
      {
        field: 'kind',
        message: expect.stringMatching(/http,mcp, mcp,http, log,event.*share measures$/),
      },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('a wrong sort answers 400 with the names the kind allows', async () => {
    const { error } = await body('/stats?kind=host&sort=calls');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([
      { field: 'sort', message: expect.stringMatching(/^sort takes cpu, cpu_avg, cpu_max, mem/) },
    ]);
  });

  it.each([
    '/stats?kind=http&by=route%3BDROP%20TABLE%20events',
    '/stats?kind=http&sort=calls%20DESC%3B%20SELECT%201',
    '/stats?kind=http&bucket=1m)%20OR%201%3D1',
    "/stats?kind=http'%20OR%201%3D1",
    '/stats?kind=http&order=desc%3B',
    '/stats?kind=http&cursor=bm9wZQ',
    `/stats?kind=http&cursor=${forged}`,
    '/stats?kind=http&status=abc',
    '/stats?kind=http&sub=a%40b.c',
    '/events?order=up',
    '/events?kind=hosts',
    '/events?status=70000',
    '/events?sub=a%40b.c',
    '/stats?kind=http,mcp%3B%20--',
    '/stats?kind=http&under=1)%20OR%201%3D1',
    '/stats?kind=event&name=',
    '/stats?kind=http&ok=1%20OR%201%3D1',
    '/events?sort=ms%3B%20--',
    '/events?ok=maybe',
  ])('refuses %s with 400 before the store', async (path) => {
    expect((await get(path)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GET /events, the new parameters', () => {
  const row = { id: '01a1c251-6d38-7407-ad7b-4bedc9fc47b3', ts: '2026-11-10 09:12:03.412' };
  const asc = SearchSchema.parse({ agcid: 'a'.repeat(32), order: 'asc' });
  const cursor = cursorOf(row, asc);

  it('order=asc reads oldest first and pages after the cursor', async () => {
    await get(`/events?agcid=${'a'.repeat(32)}&order=asc&cursor=${cursor}`);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringMatching(/\(ts, id\) > \(.*ORDER BY ts ASC, id ASC/s),
      expect.objectContaining({ cursorTs: row.ts, cursorId: row.id })
    );
  });

  it('host and container are event rows by name; sub, route, status are parameters', async () => {
    await get('/events?kind=container&sub=svc_x&route=%2Fa&status=502');
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("kind = 'event' AND fields.event.name = 'container.stats'"),
      expect.objectContaining({ sub: 'svc_x', route: '/a', status: 502 })
    );
  });
});
