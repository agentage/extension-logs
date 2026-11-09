import { createTestContext } from '@agentage/extension';
import { describe, expect, it } from 'vitest';
import { create } from './index.js';

describe('worker tick', () => {
  it('runs every minute with a 30 s timeout', () => {
    const ctx = createTestContext();
    create(ctx);
    expect(ctx.jobs).toEqual([{ name: 'tick', cron: '* * * * *', options: { timeout: '30s' } }]);
  });

  it('logs tick into its run', async () => {
    const ctx = createTestContext();
    create(ctx);
    const run = await ctx.runJob('tick');
    expect(run).toMatchObject({ job: 'tick', status: 'ok', log: 'info tick\n' });
  });
});
