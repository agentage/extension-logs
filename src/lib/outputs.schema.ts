import { z } from 'zod';
import { EventSchema } from '@agentage/extension/logs';

const text = z.string();
const num = z.number();

// A stored line as the reads answer it: camelCase, its id, ts as stored, the promoted columns.
export const EventOutSchema = EventSchema.omit({ ts: true, user_type: true, client: true }).extend({
  ...{ id: text, ts: text, userType: text, client: text, method: text, route: text },
  ...{ status: num, ms: num, ok: z.boolean() },
});
// A /stats group: its by columns (and bucket), then the kind's measures.
export const GroupOutSchema = z.record(z.string(), z.union([text, num, z.null()]));
export const GroupsMetaSchema = z.object({
  ...{ kind: text, by: z.array(text), sort: text, order: z.enum(['desc', 'asc']) },
  ...{ since: text, truncated: z.boolean(), nextCursor: text.optional() },
});
