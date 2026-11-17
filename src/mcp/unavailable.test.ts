import { createTestContext, startTestMcp } from '@agentage/extension';
import { describe, expect, it } from 'vitest';
import { create } from './index.js';

describe('the logs tools without a clickhouse store', () => {
  it('answer the UNAVAILABLE tool error', async () => {
    const server = await startTestMcp({ create, ctx: createTestContext() });
    await expect(server.call('query', {})).rejects.toThrow('The store is unavailable');
    await server.close();
  });
});
