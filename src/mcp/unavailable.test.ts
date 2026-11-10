import { createTestContext, startTestMcp } from '@agentage/extension';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/connection.js', () => ({
  readConnection: () => {
    throw new Error('store-url is not http://user:password@host:port/database');
  },
}));
const { create } = await import('./index.js');

describe('the logs tools without a store connection', () => {
  it('answer the UNAVAILABLE tool error on a malformed store-url', async () => {
    const server = await startTestMcp({ create, ctx: createTestContext() });
    await expect(server.call('search', {})).rejects.toThrow('The store is unavailable');
    await server.close();
  });
});
