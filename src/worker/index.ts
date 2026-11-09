import { type WorkerContext } from '@agentage/extension';
import '../lib/secrets.types.js';
import { clickhouse, createEventsStore } from '../lib/store.js';
import { retention } from './retention.js';

export function create({ schedule, secrets, log }: WorkerContext) {
  const store = createEventsStore(clickhouse(secrets.storeUrl), log);
  schedule('retention', '17 3 * * *', retention(store, log), { timeout: '60s' });
}
