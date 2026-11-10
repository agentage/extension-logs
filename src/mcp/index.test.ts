import { createTestContext, startTestMcp } from '@agentage/extension';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn(async (): Promise<object[]> => []));
vi.mock('../lib/store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  clickhouse: () => ({ command: async () => undefined, insert: async () => undefined, query }),
}));
vi.mock('../lib/connection.js', () => ({ readConnection: () => ({}) }));
const { create } = await import('./index.js');

const ctx = () => createTestContext();
let server: Awaited<ReturnType<typeof startTestMcp>>;
beforeAll(async () => {
  server = await startTestMcp({ create, ctx: ctx() });
});
afterAll(() => server.close());

describe('the logs tools', () => {
  it('declares five tools, each logs:admin', () => {
    const context = ctx();
    create(context);
    const tools = context.tools.map(({ name, spec }) => [name, spec.scope]);
    expect(tools).toEqual(['search', 'trace', 'errors', 'stats', 'hosts'].map((n) => [n, 'admin']));
  });

  it('search runs the api SQL with a default limit of 20', async () => {
    expect(await server.call('search', { level: 'error' })).toEqual({ events: [] });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('ORDER BY ts DESC, id DESC'),
      expect.objectContaining({ level: 'error', limit: 21 })
    );
  });

  it('trace answers an unknown agcid with no events', async () => {
    const agcid = 'f'.repeat(32);
    expect(await server.call('trace', { agcid })).toEqual({
      agcid,
      hops: 0,
      ms: 0,
      ok: true,
      events: [],
    });
  });

  it('errors, stats and hosts answer their rows', async () => {
    expect(await server.call('errors', {})).toEqual({ errors: [] });
    expect(await server.call('stats', { window: '24h' })).toEqual({ stats: [] });
    expect(await server.call('hosts', {})).toEqual({ hosts: [] });
    query.mockResolvedValueOnce([{ name: 'root_api.1', cpu: 7.5, mem: 1, limit: 2 }]);
    expect(await server.call('hosts', { host: 'next-1' })).toEqual({
      containers: [{ name: 'root_api.1', cpu: 7.5, mem: 1, limit: 2 }],
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("'container.stats'"), {
      host: 'next-1',
    });
  });
});
