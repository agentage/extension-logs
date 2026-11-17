import { createClickhouseStore } from '@agentage/extension';
import { createTestContext } from '@agentage/extension';
import { createEventsStore, fromKit } from './store.js';

// One database per test file: the files run in parallel against one ClickHouse.
export const testStore = (url: string | undefined, database: string) => {
  if (!url) return undefined;
  const log = createTestContext().log;
  const inDb = new URL(url);
  inDb.pathname = `/${database}`;
  const ch = fromKit(createClickhouseStore(inDb.href, log));
  const server = () => fromKit(createClickhouseStore(url, log));
  const store = createEventsStore(ch, log);
  const reset = async () => {
    await server().command(`CREATE DATABASE IF NOT EXISTS ${database}`);
    await ch.command('DROP TABLE IF EXISTS events');
  };
  return { ch, store, reset, drop: () => server().command(`DROP DATABASE ${database}`) };
};
