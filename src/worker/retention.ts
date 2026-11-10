import { type Log } from '@agentage/extension';
import { type EventsStore } from '../lib/store.js';

export const OLDEST = `SELECT toString(min(toDate(partition))) AS oldest,
  dateDiff('day', min(toDate(partition)), today()) AS days
FROM system.parts WHERE database = currentDatabase() AND table = 'events' AND active
HAVING count() > 0`;
// TTL 30 DAY plus a day for the merge that drops the partition.
const MAX_DAYS = 31;

// Checks the TTL dropped the partitions past 30 days; the run itself is the job row.
export const retention = (store: EventsStore, log: Log) => async () => {
  const [row] = await store.query<{ oldest: string; days: number }>(OLDEST);
  if (!row) return log.info('retention: no partitions yet, nothing to check');
  if (row.days > MAX_DAYS) throw new Error(`partition ${row.oldest} outlived the TTL`);
  log.info('retention ok', { oldest: row.oldest, days: row.days });
};
