import { createClickhouseStore, createTestContext, startTestServer } from '@agentage/extension';
import { describe, expect, it } from 'vitest';

const { create } = await import('./index.js');
const { LINES } = await import('./lines.fixture.js');

const withStore = (store: unknown) => {
  const ctx = createTestContext();
  Object.defineProperty(ctx, 'store', { value: store });
  return ctx;
};
const down = () =>
  createClickhouseStore('http://logs:x@127.0.0.1:1/logs', createTestContext().log, 300);
const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
const statuses = async (sub: string, scope: string, store: unknown) => {
  const server = await startTestServer({
    create,
    ctx: withStore(store),
    caller: { sub, scopes: [scope] },
  });
  const ingest = await server.fetch('/api/logs/events', {
    ...post,
    body: JSON.stringify([LINES.log]),
  });
  const read = await server.fetch('/api/logs/events');
  await server.close();
  return [ingest.status, read.status];
};

describe('the api part', () => {
  it('starts while the store is down and answers 503 until it is back', async () => {
    expect((await statuses('svc_shipper', 'logs:write', down()))[0]).toBe(503);
    expect((await statuses('usr_admin', 'logs:admin', down()))[1]).toBe(503);
  });

  it('answers 503 on ingest and reads while the package has no clickhouse store', async () => {
    expect((await statuses('svc_shipper', 'logs:write', undefined))[0]).toBe(503);
    expect((await statuses('usr_admin', 'logs:admin', undefined))[1]).toBe(503);
  });

  it('adds checks.clickhouse and checks.disk to /health: unavailable and degraded while the store is down', async () => {
    const ctx = withStore(down());
    create(ctx);
    expect(Object.keys(ctx.checks)).toEqual(['clickhouse', 'disk']);
    expect(await ctx.checks['clickhouse']?.()).toBe('unavailable');
    expect(await ctx.checks['disk']?.()).toBe('degraded');
  });
});
