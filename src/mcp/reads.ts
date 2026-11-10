import { z } from 'zod';
import { groups } from '../lib/groups.js';
import { GROUP_FIELDS, checkGroups, type GroupsInput } from '../lib/groups.schema.js';
import * as O from '../lib/outputs.schema.js';
import * as R from '../lib/reads.js';
import { type EventsStore } from '../lib/store.js';

// The description is the router: an AI client picks the tool and its arguments from these examples.
const QUERY = `Log rows, newest first; order "asc" reads oldest first (one request in time order).
Filters: kind (http, mcp, job, span, error, log, event, host, container), level, extension, part,
host, route, status, sub, agcid, q (text in msg, or an agcid), since and until (15m, 2h, 7d or ISO).
limit pages; nextCursor goes back as cursor. Examples:
- errors that mention a timeout, last 2 hours: {"level":"error","q":"timeout","since":"2h"}
- one request, every hop in time order: {"agcid":"<32 hex>","order":"asc","since":"30d"}
- the 500 answers of one route: {"kind":"http","route":"/api/v1/machines","status":500}
- the tool calls of one caller: {"kind":"mcp","sub":"usr_7f3a"}
For counts, failure rates, latency or machines over time use logs__aggregate.`;

const AGGREGATE = `Groups of one kind with its fixed measures, busiest first.
kind: http, mcp (calls failed requests availability p50 p95 p99 users), job (runs failed p50 p95),
span (count p50 p95 p99), error (count lastSeen sample agcid), log, event (count),
host (cpu cpu_avg cpu_max mem disk load1 containers at), container (cpu cpu_avg cpu_max mem limit at).
by: a comma list of extension, part, route, method, status, host, level, client, user_type, sub,
version (error adds type, container adds name). bucket 1m, 5m or 1h adds time as a group.
sort: a measure or a by name; order desc or asc; nulls sort last. Same filters as logs__query.
Tests and services are left out of http and mcp unless user_type is given. Examples:
- reliability per route, a day: {"kind":"http","by":"extension,part,route","since":"24h"}
- worst availability first: {"kind":"http","by":"extension,route","sort":"availability","order":"asc"}
- tool calls per tool and client: {"kind":"mcp","by":"route,client"}
- errors by type, newest first: {"kind":"error","by":"type,extension","sort":"lastSeen"}
- cpu of each machine in 5 minute steps: {"kind":"host","by":"host","bucket":"5m","since":"6h"}
meta.nextCursor goes back as cursor for the next page. For the rows themselves use logs__query.`;

const query = R.SearchSchema.extend({ limit: z.int().min(1).max(1000).default(20) });
const aggregate = z
  .object({
    ...GROUP_FIELDS,
    kind: GROUP_FIELDS.kind.meta({ description: 'what a row is; picks the measures' }),
    by: GROUP_FIELDS.by.meta({ description: 'comma list of group columns, e.g. "route,status"' }),
  })
  .superRefine(checkGroups);

export const READ_TOOLS = [
  {
    name: 'query',
    description: QUERY,
    input: query,
    output: z.object({ events: z.array(O.EventOutSchema), nextCursor: z.string().optional() }),
    run: (s: EventsStore, a: never) => R.search(s, a),
  },
  {
    name: 'aggregate',
    description: AGGREGATE,
    input: aggregate,
    output: z.object({ groups: z.array(O.GroupOutSchema), meta: O.GroupsMetaSchema }),
    run: (s: EventsStore, a: GroupsInput) => groups(s, a),
  },
] as const;
