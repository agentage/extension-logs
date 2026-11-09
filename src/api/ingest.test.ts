import { createTestContext, ok, startTestServer, type Caller } from '@agentage/extension';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EventsStore } from '../lib/store.js';
import { ingest } from './ingest.js';
import { LINES } from './lines.fixture.js';

const as = (scope: string): Caller => ({ sub: 'svc_shipper', scopes: [scope] });
const store = { ready: vi.fn(), insert: vi.fn(async () => undefined), query: vi.fn() };
let server: Awaited<ReturnType<typeof startTestServer>> | undefined;

const post = async (body: unknown, caller: Caller | null = as('logs:write')) => {
  const ctx = createTestContext();
  server = await startTestServer({
    create: (api) => ingest(api.route, store as EventsStore),
    ctx,
    caller,
  });
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  return server.fetch('/api/v1/events', { ...init, body: JSON.stringify(body) });
};

afterEach(async () => {
  await server?.close();
  store.insert.mockClear();
});

describe('POST /api/v1/events', () => {
  it('accepts the rows that fit the schema in one insert, counts the rest', async () => {
    const res = await post([LINES.http, LINES.mcp, { kind: 'nope' }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ok({ accepted: 2, rejected: 1 }));
    expect(store.insert).toHaveBeenCalledTimes(1);
    expect(store.insert.mock.calls[0]).toEqual([
      [
        expect.objectContaining({ route: '/api/v1/machines' }),
        expect.objectContaining({ route: 'probe__echo' }),
      ],
    ]);
  });

  it('counts a row outside the 30-day window as rejected, never a 500 for the batch', async () => {
    const old = { ...LINES.log, ts: '2020-01-01T00:00:00Z' };
    const res = await post([old, LINES.log]);
    expect(await res.json()).toEqual(ok({ accepted: 1, rejected: 1 }));
  });

  it('inserts nothing when every row is refused', async () => {
    expect(await (await post([{}])).json()).toEqual(ok({ accepted: 0, rejected: 1 }));
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('takes a batch of 1000 and refuses 1001 items with 400', async () => {
    expect((await post(Array(1000).fill(LINES.log))).status).toBe(200);
    await server?.close();
    expect((await post(Array(1001).fill(LINES.log))).status).toBe(400);
  });

  it('refuses a body that is not an array with 400', async () => {
    expect((await post({ events: [] })).status).toBe(400);
  });

  it('refuses a body over 1 MB with 413', async () => {
    const big = Array(50).fill({ ...LINES.log, msg: 'x'.repeat(25_000) });
    expect((await post(big)).status).toBe(413);
  });

  it('refuses an anonymous caller with 401 and logs:read with 403', async () => {
    expect((await post([LINES.log], null)).status).toBe(401);
    await server?.close();
    expect((await post([LINES.log], as('logs:read'))).status).toBe(403);
  });

  it.each([
    ['usr_dev', 'logs:write'],
    ['usr_dev', 'logs:admin'],
    ['svc', 'logs:write'],
  ])('refuses subject %s with %s: 403 FORBIDDEN, nothing inserted', async (sub, scope) => {
    const res = await post([LINES.log], { sub, scopes: [scope] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN', message: 'ingest needs a service token' },
    });
    expect(store.insert).not.toHaveBeenCalled();
  });
});
