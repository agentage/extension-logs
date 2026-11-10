import { byNames, defOf, measuresOf, nameSql, sortNames } from './kind-def.js';
import { BUCKETS, type Bucket, type KindDef, type Measure } from './kinds.js';
import { FILTERS } from './reads.sql.js';

// A planned /stats call: every name here was checked against the kind's closed lists.
export interface GroupPlan {
  kind: string;
  by: string[];
  bucket?: Bucket;
  under?: number;
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

const keysOf = (def: KindDef, { by, bucket }: GroupPlan) => [
  ...(bucket
    ? [`toDateTime64(toStartOfInterval(ts, ${BUCKETS[bucket]}), 3, 'UTC') AS bucket`]
    : []),
  ...by.map((name) => `${def.by?.[name] ?? quote(name)} AS ${quote(name)}`),
];
const selectOf = (def: KindDef, { bucket, under }: GroupPlan) =>
  Object.entries(measuresOf(def, under)).map(
    ([name, measure]) => `${sqlOf(measure, bucket !== undefined)} AS ${quote(name)}`
  );

// The rows that pass: the kind, the window, the filters given; tests and services out unless asked.
const whereOf = (def: KindDef, { filters, by }: GroupPlan) => {
  const given = Object.entries(FILTERS).filter(([key]) => filters[key] !== undefined);
  const asked = filters['user_type'] !== undefined || by.includes('user_type');
  return [
    def.where,
    FILTERS.since,
    FILTERS.until,
    ...given.map(([, sql]) => sql),
    ...(filters['name'] !== undefined ? [nameSql(def)] : []),
    ...(def.synthetic && !asked ? ["user_type NOT IN ('test', 'service')"] : []),
  ].join(' AND ');
};

// The sort first, nulls last, then every group key, so a page never reorders ties.
const orderOf = ({ sort, order, by, bucket }: GroupPlan) => {
  const keys = [...(bucket ? ['bucket'] : []), ...by].filter((key) => key !== sort);
  return [`${quote(sort)} ${DIR[order]} NULLS LAST`, ...keys.map(quote)].join(', ');
};

// The builder trusts no caller: a name outside the kind's lists never becomes SQL.
const guard = (plan: GroupPlan) => {
  const { by, bucket, sort, order, under, filters } = plan;
  const def = defOf(plan.kind);
  const known = def && (!bucket || Object.hasOwn(BUCKETS, bucket));
  if (!known || by.some((name) => !byNames(def).includes(name)))
    throw new Error('groupsSql: a kind, bucket or by outside the closed lists');
  if (!sortNames(def, by, bucket !== undefined, under).includes(sort) || !Object.hasOwn(DIR, order))
    throw new Error('groupsSql: a sort or order outside the closed lists');
  if (filters['name'] !== undefined && !nameSql(def))
    throw new Error('groupsSql: a name filter on a kind without names');
  return def;
};

// Identifiers from the kind's table, values as parameters; the inner select hides measure aliases.
export const groupsSql = (plan: GroupPlan) => {
  const def = guard(plan);
  const keys = [...(plan.bucket ? ['bucket'] : []), ...plan.by];
  const group = keys.length > 0 ? `GROUP BY ${keys.map(quote).join(', ')} ` : '';
  return `SELECT ${[...keysOf(def, plan), ...selectOf(def, plan)].join(', ')}
FROM (SELECT * FROM events WHERE ${whereOf(def, plan)})
${group}HAVING count() > 0 ORDER BY ${orderOf(plan)}
LIMIT {limit:UInt32} OFFSET {offset:UInt32}`;
};

export const groupsParams = ({ filters, since, until, limit, offset, under }: GroupPlan) => ({
  ...filters,
  ...{ since, until, limit: limit + 1, offset },
  ...(under !== undefined && { under }),
});
