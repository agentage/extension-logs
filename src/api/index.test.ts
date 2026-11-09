import { createTestContext, startTestServer } from '@agentage/extension';
import { describe, expect, it } from 'vitest';
import { create } from './index.js';
import { LINES } from './lines.fixture.js';

describe('the api part', () => {
  it('starts while the store is down and answers 503 to an ingest until it is back', async () => {
    const ctx = createTestContext({ secrets: { storeUrl: 'http://default:x@127.0.0.1:1' } });
    const server = await startTestServer({ create, ctx });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const res = await server.fetch('/api/v1/events', {
      ...init,
      body: JSON.stringify([LINES.log]),
    });
    await server.close();
    expect(res.status).toBe(503);
  });
});
