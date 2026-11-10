import { BUCKETS, KIND_DEFS, type Bucket, type GroupKind, type Measure } from './kinds.js';
import { FILTERS } from './reads.sql.js';

// A planned /stats call: every name here was checked against the kind's closed lists.
export interface GroupPlan {
  kind: GroupKind;
  by: string[];
  bucket?: Bucket;
  sort: string;
  order: 'asc' | 'desc';
  filters: Record<string, unknown>;
  since: string;
  until: string;
  limit: number;
  offset: number;
}

const DIR = { asc: 'ASC', desc: 'DESC' } as const;
const quote = (name: string) => `\`${name}\``;
const sqlOf = (measure: Measure, bucketed: boolean) =>
  typeof measure === 'string' ? measure : bucketed ? measure.step : measure.now;

const keysOf = ({ kind, by, bucket }: GroupPlan) => [
  ...(bucket
    ? [`toDateTime64(toStartOfInterval(ts, ${BUCKETS[bucket]}), 3, 'UTC') AS bucket`]
    : []),
  ...by.map((name) => `${KIND_DEFS[kind].by?.[name] ?? quote(name)} AS ${quote(name)}`),
];
const measuresOf = ({ kind, bucket }: GroupPlan) =>
  Object.entries(KIND_DEFS[kind].measures).map(
    ([name, measure]) => `${sqlOf(measure, bucket !== undefined)} AS ${quote(name)}`
  );

// The rows that pass: the kind, the window, the filters given; tests and services out unless asked.
const whereOf = ({ kind, filters }: GroupPlan) => {
  const given = Object.entries(FILTERS).filter(([key]) => filters[key] !== undefined);
  const synthetic = KIND_DEFS[kind].synthetic && filters['user_type'] === undefined;
  return [
    KIND_DEFS[kind].where,
    FILTERS.since,
    FILTERS.until,
    ...given.map(([, sql]) => sql),
    ...(synthetic ? ["user_type NOT IN ('test', 'service')"] : []),
  ].join(' AND ');
};

// The sort first, nulls last, then every group key, so a page never reorders ties.
const orderOf = ({ sort, order, by, bucket }: GroupPlan) => {
  const keys = [...(bucket ? ['bucket'] : []), ...by].filter((key) => key !== sort);
  return [`${quote(sort)} ${DIR[order]} NULLS LAST`, ...keys.map(quote)].join(', ');
};

// One statement; identifiers come from the kind's table only, every value is a query parameter.
// The inner select keeps a measure's alias (agcid) from reaching the filters.
export const groupsSql = (plan: GroupPlan) => {
  const keys = [...(plan.bucket ? ['bucket'] : []), ...plan.by];
  const group = keys.length > 0 ? `GROUP BY ${keys.map(quote).join(', ')} ` : '';
  return `SELECT ${[...keysOf(plan), ...measuresOf(plan)].join(', ')}
FROM (SELECT * FROM events WHERE ${whereOf(plan)})
${group}HAVING count() > 0 ORDER BY ${orderOf(plan)}
LIMIT {limit:UInt32} OFFSET {offset:UInt32}`;
};

export const groupsParams = ({ filters, since, until, limit, offset }: GroupPlan) => ({
  ...filters,
  ...{ since, until, limit: limit + 1, offset },
});
