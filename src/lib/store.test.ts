import { createTestContext } from '@agentage/extension';
import { describe, expect, it, vi } from 'vitest';
import { EVENTS_DDL } from './ddl.js';
import { createEventsStore, isOutage, type Clickhouse } from './store.js';

const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const fake = (command = vi.fn(async () => undefined)) => {
  const ch: Clickhouse = {
    command,
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
  };
  return { ch, store: createEventsStore(ch, createTestContext().log) };
};

describe('the events store', () => {
  it('runs the DDL once, before the first use', async () => {
    const { ch, store } = fake();
    await Promise.all([store.ready(), store.insert([{ a: 1 }]), store.query('SELECT 1')]);
    expect(ch.command).toHaveBeenCalledTimes(1);
    expect(ch.command).toHaveBeenCalledWith(EVENTS_DDL);
    expect(ch.insert).toHaveBeenCalledWith('events', [{ a: 1 }]);
  });

  it('answers UNAVAILABLE while the store is down, and runs the DDL again when it is back', async () => {
    const command = vi.fn().mockRejectedValueOnce(refused).mockResolvedValue(undefined);
    const { ch, store } = fake(command);
    await expect(store.ready()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await store.insert([]);
    expect(ch.command).toHaveBeenCalledTimes(2);
  });

  it('passes a SQL error through as it is', async () => {
    const { ch, store } = fake();
    vi.mocked(ch.query).mockRejectedValueOnce(new Error('Syntax error'));
    await expect(store.query('SELEC')).rejects.toThrow('Syntax error');
  });

  it.each([
    [refused, true],
    [new Error('Timeout error.'), true],
    [Object.assign(new Error('Syntax error'), { code: '62' }), false],
    [null, false],
  ])('tells an outage from a fault (%#)', (err, outage) => {
    expect(isOutage(err)).toBe(outage);
  });
});
