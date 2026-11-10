import { encodePage } from './cursor.js';
import { Since, iso, pinnedEnd } from './filters.schema.js';
import { filtersOf, keyOf, sortOf, type GroupsInput } from './groups.schema.js';
import { groupsParams, groupsSql, type GroupPlan } from './groups.sql.js';
import { KIND_DEFS } from './kinds.js';
import { type EventsStore, type Row } from './store.js';

// ClickHouse answers a time as '2026-11-10 14:00:00.000'; the reads answer ISO.
const TIMES = ['bucket', 'at', 'lastSeen'];
const toGroup = (row: Row): Row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, TIMES.includes(k) ? iso(v) : v]));

// The window of page 1 is pinned in the cursor, so every page is cut from the same rows.
const windowOf = ({ cursor, since, until, kind }: GroupsInput) =>
  cursor
    ? { since: cursor.s, until: cursor.u, offset: cursor.o }
    : {
        since: Since.parse(since ?? KIND_DEFS[kind].since),
        until: until ? Since.parse(until) : pinnedEnd(),
        offset: 0,
      };

export const planOf = (input: GroupsInput): GroupPlan => ({
  ...{ kind: input.kind, by: input.by ?? [], bucket: input.bucket, ...sortOf(input) },
  ...{ filters: filtersOf(input), limit: input.limit, ...windowOf(input) },
});

// Groups with the kind's measures, one page; nextCursor when more groups exist.
export const groups = async (store: EventsStore, input: GroupsInput) => {
  const plan = planOf(input);
  const rows = await store.query(groupsSql(plan), groupsParams(plan));
  const truncated = rows.length > plan.limit;
  const next = { o: plan.offset + plan.limit, s: plan.since, u: plan.until, k: keyOf(input) };
  const meta = {
    ...{ kind: plan.kind, by: plan.by, sort: plan.sort, order: plan.order },
    ...{ since: input.since ?? KIND_DEFS[plan.kind].since, truncated },
    ...(truncated && { nextCursor: encodePage(next) }),
  };
  return { groups: rows.slice(0, plan.limit).map(toGroup), meta };
};
