import { z } from 'zod';
import { EventSchema } from '@agentage/extension/logs';

const text = z.string();
const num = z.number();
const maybe = z.number().nullable();

// A stored line as the reads answer it: camelCase, its id, ts as stored, the promoted columns.
export const EventOutSchema = EventSchema.omit({ ts: true, user_type: true, client: true }).extend({
  ...{ id: text, ts: text, userType: text, client: text, method: text, route: text },
  ...{ status: num, ms: num, ok: z.boolean() },
});
const events = z.array(EventOutSchema);
export const TraceOutSchema = z.object({
  agcid: text,
  hops: num,
  ms: num,
  ok: z.boolean(),
  events,
});
const group = { extension: text, part: text, kind: text, method: text, route: text };
const counts = { calls: num, errors: num, failed: num, requests: num, users: num };
const latency = { availability: maybe, p50: num, p95: num, p99: num };
export const StatOutSchema = z.object({ ...group, ...counts, ...latency });
const sample = {
  cpu: maybe,
  cpu1h: maybe,
  mem: maybe,
  disk: maybe,
  load1: maybe,
  containers: maybe,
};
export const HostOutSchema = z.object({ host: text, ...sample, at: text, red: z.boolean() });
export const ContainerOutSchema = z.object({ name: text, cpu: maybe, mem: maybe, limit: maybe });
export const ErrorOutSchema = z.object({
  ...{ type: text, msg: text, count: num, lastSeen: text, agcid: text.nullable() },
});
