import { createHash } from 'node:crypto';
import { z } from 'zod';
import { STAMP, decodeCursor } from './filters.schema.js';

// What a /stats page cursor holds: the offset, the pinned window, the query it belongs to.
const PageSchema = z.strictObject({
  o: z.int().min(0).max(1_000_000),
  s: z.string().regex(STAMP),
  u: z.string().regex(STAMP),
  k: z.string().regex(/^[0-9a-f]{16}$/),
});
export type Page = z.output<typeof PageSchema>;

export const PageCursor = z.string().max(300).transform(decodeCursor).pipe(PageSchema);
export const encodePage = (page: Page) => Buffer.from(JSON.stringify(page)).toString('base64url');

// The query's identity without its page: a cursor from another kind, by, sort, order or filter is refused.
export const queryKey = (query: Record<string, unknown>) =>
  createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 16);
