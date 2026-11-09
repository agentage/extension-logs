import { z } from 'zod';
import { fail, type ApiContext } from '@agentage/extension';
import { type EventsStore } from '../lib/store.js';
import { toRow, type Row } from './rows.js';

export const MAX_ITEMS = 1000;

// C3 posts a bare JSON array; the kit types input as an object but parses whatever schema it gets.
const input = z.array(z.unknown()).max(MAX_ITEMS) as unknown as z.ZodObject;
const output = z.object({ accepted: z.int().min(0), rejected: z.int().min(0) });

export const ingest = (route: ApiContext['route'], store: EventsStore) =>
  route(
    'post',
    '/events',
    { summary: 'Ingest events', scope: 'write', input, output },
    async (req) => {
      // Any account can mint logs:write; only an admin mints a svc_ subject.
      if (!req.caller?.sub.startsWith('svc_'))
        throw fail('FORBIDDEN', 'ingest needs a service token');
      const rows = (req.input as unknown as unknown[]).map(toRow);
      const accepted = rows.filter((row): row is Row => row !== null);
      if (accepted.length > 0) await store.insert(accepted);
      return { accepted: accepted.length, rejected: rows.length - accepted.length };
    }
  );
