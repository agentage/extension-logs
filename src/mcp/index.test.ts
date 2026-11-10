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
const STAT = {
  ...{ extension: 'x', part: 'edge', kind: 'http', method: 'GET', calls: 1, errors: 0 },
  ...{ failed: 0, requests: 1, users: 0, availability: null, q: [1, 2, 3] },
};
let server: Awaited<ReturnType<typeof startTestMcp>>;
beforeAll(async () => {
  server = await startTestMcp({ create, ctx: ctx() });
});
afterAll(() => server.close());

describe('the logs tools', () => {
  it('declares the five tools of 0.2 and the two reads, each logs:admin', () => {
    const context = ctx();
    create(context);
    const tools = context.tools.map(({ name, spec }) => [name, spec.scope]);
    const names = ['search', 'trace', 'errors', 'stats', 'hosts', 'query', 'aggregate'];
    expect(tools).toEqual(names.map((n) => [n, 'admin']));
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
    const many = Array.from({ length: 201 }, (_, i) => ({ ...STAT, route: `/${i}` }));
    query.mockResolvedValueOnce(many);
    const cut = (await server.call('stats', { window: '24h' })) as {
      stats: object[];
      note: string;
    };
    expect(cut.stats).toHaveLength(200);
    expect(cut.note).toMatch(/^truncated: /);
    expect(await server.call('hosts', {})).toEqual({ hosts: [] });
    query.mockResolvedValueOnce([{ name: 'root_api.1', cpu: 7.5, mem: 1, limit: 2 }]);
    expect(await server.call('hosts', { host: 'next-1' })).toEqual({
      containers: [{ name: 'root_api.1', cpu: 7.5, mem: 1, limit: 2 }],
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("'container.stats'"), {
      host: 'next-1',
    });
  });

  it.each([{ host: '../x' }, { host: 'a/b' }])(
    'hosts refuses %o before the store',
    async (args) => {
      query.mockClear();
      await expect(server.call('hosts', args)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    }
  );
});
