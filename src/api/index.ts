import { type ApiContext } from '@agentage/extension';
import { readConnection } from '../lib/connection.js';
import { clickhouse, lazy, clickhouseCheck, createEventsStore } from '../lib/store.js';
import { ingest } from './ingest.js';
import { reads } from './reads.js';

// Mounted at /api/v1; openapi.json is generated from these routes.
export function create({ route, log, health }: ApiContext) {
  const ch = lazy(() => clickhouse(readConnection()), log);
  health('clickhouse', clickhouseCheck(ch));
  const store = createEventsStore(ch, log);
  void store.ready().catch(() => undefined);
  ingest(route, store);
  reads(route, store);
}
