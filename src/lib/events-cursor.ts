import { z } from 'zod';
import { queryKey } from './cursor.js';
import { FILTER_FIELDS, STAMP, decodeCursor } from './filters.schema.js';
import { NAME_RULE, nameSql } from './kind-def.js';
import { KIND_DEFS, type GroupKind } from './kinds.js';
import { type Row } from './store.js';

// The /events cursor: the last row's ts, id (and ms under sort=ms), and the query it belongs to.
export const EventsCursor = z
  .string()
  .max(300)
  .transform(decodeCursor)
  .pipe(
    z.strictObject({
      ...{ t: z.string().regex(STAMP), i: z.uuid() },
      m: z.int().min(0).max(4_294_967_295).optional(),
      k: z.string().regex(/^[0-9a-f]{16}$/),
    })
  );
type Query = Record<string, unknown> & { kind?: GroupKind; sort?: string; order?: string };
type Checked = Query & { cursor?: z.output<typeof EventsCursor>; name?: string };

// The query without its page: kind, filters, sort, order.
export const eventsKey = (input: Query) =>
  queryKey({
    ...{ kind: input.kind, sort: input.sort ?? 'ts', order: input.order ?? 'desc' },
    filters: Object.fromEntries(Object.keys(FILTER_FIELDS).map((key) => [key, input[key]])),
  });
export const cursorOf = (row: Row, input: Query) => {
  const m = input.sort === 'ms' ? { m: row['ms'] } : {};
  const page = { t: row['ts'], i: row['id'], ...m, k: eventsKey(input) };
  return Buffer.from(JSON.stringify(page)).toString('base64url');
};

// What name filters on /events: as by=name on the kind; without a kind the event name.
export const eventsName = (kind?: GroupKind) => nameSql(KIND_DEFS[kind ?? 'any']);

// A cursor of another query would skip or repeat rows; name needs a kind that has names.
export const checkSearch = (input: Checked, ctx: z.RefinementCtx) => {
  const { cursor, sort } = input;
  const other =
    cursor && (cursor.k !== eventsKey(input) || (cursor.m !== undefined) !== (sort === 'ms'));
  if (other)
    ctx.addIssue({
      code: 'custom',
      path: ['cursor'],
      message: 'the cursor belongs to another query',
    });
  if (input.name !== undefined && !eventsName(input.kind))
    ctx.addIssue({ code: 'custom', path: ['name'], message: NAME_RULE });
};
