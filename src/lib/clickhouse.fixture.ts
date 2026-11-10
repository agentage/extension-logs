import { createTestContext } from '@agentage/extension';
import { parseStoreUrl } from './connection.js';
import { clickhouse, createEventsStore } from './store.js';

// One database per test file: the files run in parallel against one ClickHouse.
export const testStore = (url: string | undefined, database: string) => {
  if (!url) return undefined;
  const ch = clickhouse({ ...parseStoreUrl(url), database });
  const server = () => clickhouse(parseStoreUrl(url));
  const store = createEventsStore(ch, createTestContext().log);
  const reset = async () => {
    await server().command(`CREATE DATABASE IF NOT EXISTS ${database}`);
    await ch.command('DROP TABLE IF EXISTS events');
  };
  return { ch, store, reset, drop: () => server().command(`DROP DATABASE ${database}`) };
};
