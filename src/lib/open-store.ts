import { type Log } from '@agentage/extension';
import { readConnection } from './connection.js';
import { clickhouse, createEventsStore, lazy } from './store.js';

export const openStore = (log: Log) => {
  const ch = lazy(() => clickhouse(readConnection()), log);
  return { ch, store: createEventsStore(ch, log) };
};
