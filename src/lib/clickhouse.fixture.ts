import { createTestContext } from '@agentage/extension';
import { clickhouse, createEventsStore } from './store.js';

// One database per test file: the files run in parallel against one ClickHouse.
export const testStore = (url: string | undefined, database: string) => {
  if (!url) return undefined;
  const ch = clickhouse(`${url.replace(/\/$/, '')}/${database}`);
  const store = createEventsStore(ch, createTestContext().log);
  const reset = async () => {
    await clickhouse(url).command(`CREATE DATABASE IF NOT EXISTS ${database}`);
    await ch.command('DROP TABLE IF EXISTS events');
  };
  return { ch, store, reset, drop: () => clickhouse(url).command(`DROP DATABASE ${database}`) };
};
