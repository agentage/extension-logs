import { createTestContext, startTestServer, type Caller } from '@agentage/extension';
import { describe, expect, it } from 'vitest';
import { create } from './index.js';

const READ: Caller = { sub: 'usr_r', scopes: ['logs:read', 'other:admin'] };
const get = async (caller: Caller | null) => {
  const ctx = createTestContext();
  const server = await startTestServer({ create, ctx, caller });
  const res = await server.fetch('/api/logs/caller');
  await server.close();
  await ctx.close();
  return { status: res.status, body: await res.json() };
};

describe('GET /api/logs/caller (kit built-in)', () => {
  it('names the caller and only its own logs scopes', async () => {
    expect(await get(READ)).toEqual({
      status: 200,
      body: { success: true, data: { sub: 'usr_r', scopes: ['logs:read'] } },
    });
  });

  it('answers 401 with no token', async () => {
    expect((await get(null)).status).toBe(401);
  });
});
