import { type ApiContext } from '@agentage/extension';
import '../lib/secrets.types.js';
import { clickhouse, createEventsStore } from '../lib/store.js';
import { ingest } from './ingest.js';
import { reads } from './reads.js';

// Mounted at /api/v1; openapi.json is generated from these routes.
export function create({ route, secrets, log }: ApiContext) {
  const store = createEventsStore(clickhouse(secrets.storeUrl), log);
  void store.ready().catch(() => undefined);
  ingest(route, store);
  reads(route, store);
}
