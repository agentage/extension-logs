import { z } from 'zod';
import { PageCursor, queryKey } from './cursor.js';
import { FILTER_FIELDS, Order, Since, USER_TYPE, iso, pinnedEnd } from './filters.schema.js';
import {
  BUCKETS,
  BUCKET_MS,
  GROUP_KINDS,
  KIND_DEFS,
  MAX_STEPS,
  byNames,
  sortNames,
  type Bucket,
} from './kinds.js';

// Kept as given, so meta.since echoes it; the read turns it into a time.
const When = z.union([z.string().regex(/^\d{1,4}[mhd]$/), z.iso.datetime({ offset: true })]);
const List = z
  .string()
  .max(200)
  .transform((text) => [...new Set(text.split(','))]);

export const FILTER_NAMES = [
  ...(Object.keys(FILTER_FIELDS) as (keyof typeof FILTER_FIELDS)[]),
  'user_type',
] as const;
export const GROUP_FIELDS = {
  ...FILTER_FIELDS,
  ...{ user_type: USER_TYPE.optional(), since: When.optional(), until: When.optional() },
  kind: z.enum(GROUP_KINDS),
  by: List.optional(),
  bucket: z.enum(Object.keys(BUCKETS) as [Bucket, ...Bucket[]]).optional(),
  ...{ sort: z.string().max(32).optional(), order: Order.optional() },
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: PageCursor.optional(),
};
type Fields = z.output<z.ZodObject<typeof GROUP_FIELDS>>;
export type GroupsInput = Fields;

// The sort and order a call means: busiest first, or with a bucket, time oldest first.
export const sortOf = (input: Fields) => ({
  sort: input.sort ?? (input.bucket ? 'bucket' : KIND_DEFS[input.kind].sort),
  order: input.order ?? (input.sort === undefined && input.bucket ? 'asc' : 'desc'),
});
export const filtersOf = (input: Fields) =>
  Object.fromEntries(
    FILTER_NAMES.map((key) => [key, input[key]]).filter(([, v]) => v !== undefined)
  );
export const keyOf = (input: Fields) =>
  queryKey({
    ...{ kind: input.kind, by: input.by ?? [], bucket: input.bucket, ...sortOf(input) },
    ...{ filters: filtersOf(input), since: input.since, until: input.until },
  });

type Issue = { message: string; path: string[] };
const outside = (given: string[], allowed: string[]) => given.some((n) => !allowed.includes(n));
const windowIssues = ({ since, until, kind, bucket }: Fields) => {
  const start = Since.parse(since ?? KIND_DEFS[kind].since);
  const end = until ? Since.parse(until) : pinnedEnd();
  const steps = bucket ? (Date.parse(iso(end)) - Date.parse(iso(start))) / BUCKET_MS[bucket] : 0;
  return [
    start >= end && { path: ['since'], message: 'since must be before until' },
    steps > MAX_STEPS && {
      ...{
        path: ['bucket'],
        message: `at most ${MAX_STEPS} steps: a larger bucket or a shorter since`,
      },
    },
  ];
};
const issuesOf = (input: Fields): Issue[] => {
  const by = byNames(input.kind);
  const sorts = sortNames(input.kind, input.by ?? [], input.bucket !== undefined);
  return [
    outside(input.by ?? [], by) && { path: ['by'], message: `by takes ${by.join(', ')}` },
    outside([sortOf(input).sort], sorts) && {
      path: ['sort'],
      message: `sort takes ${sorts.join(', ')}`,
    },
    ...windowIssues(input),
    input.cursor &&
      input.cursor.k !== keyOf(input) && {
        ...{ path: ['cursor'], message: 'the cursor belongs to another query' },
      },
  ].filter((issue): issue is Issue => Boolean(issue));
};

// The per-kind rules: by, sort and a cursor are checked against the kind's closed lists.
export const checkGroups = (
  input: Omit<Fields, 'kind'> & { kind?: Fields['kind'] },
  ctx: z.RefinementCtx
) => {
  if (input.kind === undefined) return;
  for (const { message, path } of issuesOf(input as Fields))
    ctx.addIssue({ code: 'custom', message, path });
};

export const GroupsQuery = z.object(GROUP_FIELDS).superRefine(checkGroups);
