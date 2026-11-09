import {
  createTestContext,
  ok,
  startTestServer,
  type PartContext,
  type Store,
} from '@agentage/extension';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from './index.js';

const ctx = createTestContext();
const { store } = ctx.extension;
let server: Awaited<ReturnType<typeof startTestServer>>;
// The store boots (WASM, migrations, seed) on first use: here, not inside a test's 5 s.
beforeAll(async () => {
  if (store) await ctx.store.query('select 1');
  server = await startTestServer({ create, ctx });
}, 30_000);
afterAll(async () => {
  await server.close();
  await ctx.close();
});

describe('GET /api/v1/echo', () => {
  it('echoes msg and names the caller', async () => {
    const res = await server.fetch('/api/v1/echo?msg=hi');
    expect(await res.json()).toEqual(ok({ msg: 'hi', caller: 'usr_test' }));
  });

  it.each([
    ['empty', ''],
    ['over 200 characters', 'x'.repeat(201)],
  ])('refuses a msg %s', async (_name, msg) => {
    expect((await server.fetch(`/api/v1/echo?msg=${msg}`)).status).toBe(400);
  });
});

const ping = async (ctx: PartContext) => {
  const one = await startTestServer({ create, ctx });
  const body: unknown = await (await one.fetch('/api/v1/ping')).json();
  await one.close();
  return body;
};

describe('GET /api/v1/ping', () => {
  it('counts the rows of pings when the manifest keeps the store', async () => {
    const counted = { query: async () => ({ rows: [{ n: 3 }] }) } as Store;
    const ctx = createTestContext({ extension: { store: 'postgres' } });
    const body = await ping({ ...ctx, store: counted });
    expect(body).toEqual(ok({ msg: 'pong', pings: 3 }));
  });

  it('answers pings null without a store', async () => {
    const body = await ping(createTestContext({ store: false }));
    expect(body).toEqual(ok({ msg: 'pong', pings: null }));
  });

  it.runIf(store)('counts the seeded row: the migration and the seed ran', async () => {
    const res = await server.fetch('/api/v1/ping');
    expect(await res.json()).toEqual(ok({ msg: 'pong', pings: 1 }));
  });
});
