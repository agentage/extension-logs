import { createTestContext } from '@agentage/extension';
import { describe, expect, it, vi } from 'vitest';
import { type EventsStore } from '../lib/store.js';
import { create } from './index.js';
import { OLDEST, retention } from './retention.js';

const run = async (rows: object[]) => {
  const ctx = createTestContext();
  const query = vi.fn(async () => rows);
  const store = { query } as unknown as EventsStore;
  ctx.schedule('retention', '17 3 * * *', retention(store, ctx.log));
  return { run: await ctx.runJob('retention'), query };
};

describe('worker retention', () => {
  it('runs nightly at 03:17 UTC with a 60 s timeout', () => {
    const ctx = createTestContext({ secrets: { storeUrl: 'http://ch:8123' } });
    create(ctx);
    expect(ctx.jobs).toEqual([
      { name: 'retention', cron: '17 3 * * *', options: { timeout: '60s' } },
    ]);
  });

  it('passes when the oldest partition is inside the TTL, read from system.parts', async () => {
    const { run: done, query } = await run([{ oldest: '2026-10-12', days: 28 }]);
    expect(done).toMatchObject({ status: 'ok' });
    expect(query).toHaveBeenCalledWith(OLDEST);
  });

  it('passes on an empty table', async () => {
    expect((await run([])).run).toMatchObject({ status: 'ok' });
  });

  it('fails when a partition outlived the TTL', async () => {
    expect((await run([{ oldest: '2026-09-01', days: 69 }])).run).toMatchObject({
      status: 'failed',
    });
  });
});
