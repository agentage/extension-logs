import { createTestContext, startTestServer } from '@agentage/extension';
import { describe, expect, it, vi } from 'vitest';

const down = { url: 'http://127.0.0.1:1', username: 'logs', password: 'x', database: 'logs' };
vi.mock('../lib/connection.js', () => ({ readConnection: () => down }));
const { create } = await import('./index.js');
const { LINES } = await import('./lines.fixture.js');

describe('the api part', () => {
  it('starts while the store is down and answers 503 to an ingest until it is back', async () => {
    const caller = { sub: 'svc_shipper', scopes: ['logs:write'] };
    const server = await startTestServer({ create, ctx: createTestContext(), caller });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const res = await server.fetch('/api/v1/events', {
      ...init,
      body: JSON.stringify([LINES.log]),
    });
    await server.close();
    expect(res.status).toBe(503);
  });

  it('adds checks.clickhouse to /health: unavailable while the store is down', async () => {
    const ctx = createTestContext();
    create(ctx);
    expect(await ctx.checks['clickhouse']?.()).toBe('unavailable');
  });
});
