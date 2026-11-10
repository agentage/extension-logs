import { type ApiContext } from '@agentage/extension';
import { openStore } from '../lib/open-store.js';
import { clickhouseCheck, diskCheck } from '../lib/store.js';
import { ingest } from './ingest.js';
import { reads } from './reads.js';

// Mounted at /api/v1; openapi.json is generated from these routes.
export function create({ route, log, health }: ApiContext) {
  const { ch, store } = openStore(log);
  health('clickhouse', clickhouseCheck(ch));
  health('disk', diskCheck(ch, log));
  void store.ready().catch(() => undefined);
  ingest(route, store);
  reads(route, store);
}
