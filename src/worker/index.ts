import { type WorkerContext } from '@agentage/extension';
import { readConnection } from '../lib/connection.js';
import { clickhouse, lazy, createEventsStore } from '../lib/store.js';
import { retention } from './retention.js';

export function create({ schedule, log }: WorkerContext) {
  const store = createEventsStore(
    lazy(() => clickhouse(readConnection()), log),
    log
  );
  schedule('retention', '17 3 * * *', retention(store, log), { timeout: '60s' });
}
