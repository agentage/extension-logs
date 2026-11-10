import { encodePage } from './cursor.js';
import { Since, iso, pinnedEnd } from './filters.schema.js';
import { defIn, filtersOf, keyOf, sortOf, type GroupsInput } from './groups.schema.js';
import { groupsParams, groupsSql, type GroupPlan } from './groups.sql.js';
import { type EventsStore, type Row } from './store.js';

// ClickHouse answers a time as '2026-11-10 14:00:00.000'; the reads answer ISO.
const TIMES = ['bucket', 'at', 'firstSeen', 'lastSeen'];
// Shares to 4 decimals, any other fraction (quantiles, averages, percents) to 2; counts stay.
const SHARES = ['availability', 'under'];
const round = (key: string, value: number) =>
  Number.isInteger(value) ? value : Number(value.toFixed(SHARES.includes(key) ? 4 : 2));
const valueOf = (key: string, value: unknown) =>
  TIMES.includes(key) ? iso(value) : typeof value === 'number' ? round(key, value) : value;
const toGroup = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, valueOf(k, v)]));

// The window of page 1 is pinned in the cursor, so every page is cut from the same rows.
const windowOf = (input: GroupsInput) =>
  input.cursor
    ? { since: input.cursor.s, until: input.cursor.u, offset: input.cursor.o }
    : {
        since: Since.parse(input.since ?? defIn(input).since),
        until: input.until ? Since.parse(input.until) : pinnedEnd(),
        offset: 0,
      };

export const planOf = (input: GroupsInput): GroupPlan => ({
  ...{ kind: input.kind, by: input.by ?? [], bucket: input.bucket, under: input.under },
  ...{ ...sortOf(input), filters: filtersOf(input), limit: input.limit, ...windowOf(input) },
});

// Groups with the kind's measures, one page; nextCursor when more groups exist.
export const groups = async (store: EventsStore, input: GroupsInput) => {
  const plan = planOf(input);
  const rows = await store.query(groupsSql(plan), groupsParams(plan));
  const truncated = rows.length > plan.limit;
  const next = { o: plan.offset + plan.limit, s: plan.since, u: plan.until, k: keyOf(input) };
  const meta = {
    ...{ kind: plan.kind, by: plan.by, sort: plan.sort, order: plan.order },
    ...{ since: input.since ?? defIn(input).since, truncated },
    ...(truncated && { nextCursor: encodePage(next) }),
  };
  return { groups: rows.slice(0, plan.limit).map(toGroup), meta };
};
