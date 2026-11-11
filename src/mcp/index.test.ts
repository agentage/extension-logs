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
  it('declares the two reads only, each logs:admin', () => {
    const context = ctx();
    create(context);
    const tools = context.tools.map(({ name, spec }) => [name, spec.scope]);
    expect(tools).toEqual([
      ['query', 'admin'],
      ['aggregate', 'admin'],
    ]);
  });

  it('query reads rows oldest first for a trace, with a next cursor', async () => {
    expect(await server.call('query', { agcid: 'a'.repeat(32), order: 'asc' })).toEqual({
      events: [],
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('ORDER BY ts ASC, id ASC'),
      expect.objectContaining({ agcid: 'a'.repeat(32), limit: 21 })
    );
  });

  it('aggregate answers groups and meta; a wrong sort is refused before the store', async () => {
    query.mockResolvedValueOnce([{ route: 'probe__echo', calls: 2 }]);
    expect(await server.call('aggregate', { kind: 'mcp', by: 'route', status: 0 })).toEqual({
      groups: [{ route: 'probe__echo', calls: 2 }],
      meta: {
        kind: 'mcp',
        by: ['route'],
        sort: 'calls',
        order: 'desc',
        since: '24h',
        truncated: false,
      },
    });
    query.mockClear();
    await expect(server.call('aggregate', { kind: 'mcp', sort: 'cpu' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('each read tool carries examples for a client to pick its arguments', () => {
    const context = ctx();
    create(context);
    for (const name of ['query', 'aggregate']) {
      const spec = context.tools.find((t) => t.name === name)?.spec as { description: string };
      expect(spec.description.match(/^- .*: \{/gm)?.length).toBeGreaterThanOrEqual(4);
    }
  });
});
