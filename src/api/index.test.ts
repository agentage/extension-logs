import { createTestContext, startTestServer } from '@agentage/extension';
import { describe, expect, it, vi } from 'vitest';

const down = { url: 'http://127.0.0.1:1', username: 'logs', password: 'x', database: 'logs' };
const connection = vi.hoisted(() => ({ read: (): unknown => undefined }));
vi.mock('../lib/connection.js', () => ({ readConnection: () => connection.read() }));
const { create } = await import('./index.js');
const { LINES } = await import('./lines.fixture.js');

const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
const statuses = async (sub: string, scope: string) => {
  const server = await startTestServer({
    create,
    ctx: createTestContext(),
    caller: { sub, scopes: [scope] },
  });
  const ingest = await server.fetch('/api/v1/events', {
    ...post,
    body: JSON.stringify([LINES.log]),
  });
  const read = await server.fetch('/api/v1/events');
  await server.close();
  return [ingest.status, read.status];
};

describe('the api part', () => {
  it('starts while the store is down and answers 503 until it is back', async () => {
    connection.read = () => down;
    expect((await statuses('svc_shipper', 'logs:write'))[0]).toBe(503);
    expect((await statuses('usr_admin', 'logs:admin'))[1]).toBe(503);
  });

  it('answers 503 on ingest and reads while store-url is missing', async () => {
    connection.read = () => {
      throw new Error('/run/secrets/store-url has no value: the store is not mounted');
    };
    expect((await statuses('svc_shipper', 'logs:write'))[0]).toBe(503);
    expect((await statuses('usr_admin', 'logs:admin'))[1]).toBe(503);
  });

  it('adds checks.clickhouse and checks.disk to /health: unavailable and degraded while the store is down', async () => {
    connection.read = () => down;
    const ctx = createTestContext();
    create(ctx);
    expect(Object.keys(ctx.checks)).toEqual(['clickhouse', 'disk']);
    expect(await ctx.checks['clickhouse']?.()).toBe('unavailable');
    expect(await ctx.checks['disk']?.()).toBe('degraded');
  });
});
