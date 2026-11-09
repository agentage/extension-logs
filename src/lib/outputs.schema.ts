import { z } from 'zod';

const text = z.string();
const maybe = z.string().nullable();
const num = z.number().nullable();

export const EventOutSchema = z.object({
  id: text,
  ts: text,
  level: text,
  kind: text,
  msg: text,
  extension: text,
  part: text,
  version: text,
  host: text,
  agcid: maybe,
  sub: maybe,
  session: maybe,
  userType: text,
  client: text,
  method: text,
  route: text,
  status: z.number(),
  ms: z.number(),
  ok: z.boolean(),
  fields: z.record(z.string(), z.unknown()),
});

export const TraceOutSchema = z.object({
  agcid: text,
  hops: z.number(),
  ms: z.number(),
  ok: z.boolean(),
  events: z.array(EventOutSchema),
});

export const StatOutSchema = z.object({
  extension: text,
  part: text,
  kind: text,
  method: text,
  route: text,
  calls: z.number(),
  errors: z.number(),
  failed: z.number(),
  requests: z.number(),
  availability: num,
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  users: z.number(),
});

export const HostOutSchema = z.object({
  host: text,
  cpu: num,
  cpu1h: num,
  mem: num,
  disk: num,
  load1: num,
  containers: num,
  at: text,
  red: z.boolean(),
});

export const ContainerOutSchema = z.object({ name: text, cpu: num, mem: num, limit: num });

export const ErrorOutSchema = z.object({
  type: text,
  msg: text,
  count: z.number(),
  lastSeen: text,
  agcid: maybe,
});
