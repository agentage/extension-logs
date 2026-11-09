import { createTestContext, startTestMcp } from '@agentage/extension';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from './index.js';

let server: Awaited<ReturnType<typeof startTestMcp>>;
beforeAll(async () => {
  server = await startTestMcp({ create, ctx: createTestContext() });
});
afterAll(() => server.close());

describe('logs__echo', () => {
  it('declares scope read', () => {
    const ctx = createTestContext();
    create(ctx);
    expect(ctx.tools.map(({ name, spec }) => [name, spec.scope])).toEqual([['echo', 'read']]);
  });

  it('answers pong and the message', async () => {
    expect(await server.call('echo', { msg: 'hi' })).toEqual({ msg: 'pong hi' });
  });
});
