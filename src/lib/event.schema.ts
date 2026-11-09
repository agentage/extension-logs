import { z } from 'zod';

// A local copy of C2 (`EventSchema` of @agentage/logs) until that package is on npm.
export const LEVELS = ['info', 'warn', 'error'] as const;
export const KINDS = ['http', 'mcp', 'job', 'span', 'error', 'event', 'log'] as const;
export const USER_TYPES = ['user', 'agent', 'automation', 'service', 'test', 'bot'] as const;

const name = z.string().min(1).max(64);
const optional = z.string().max(200).nullable().default(null);

export const EventSchema = z.object({
  ts: z.iso.datetime({ offset: true }),
  level: z.enum(LEVELS).default('info'),
  kind: z.enum(KINDS),
  msg: z.string(),
  extension: name,
  part: name,
  version: z.string().max(64).default(''),
  host: z.string().max(253).default(''),
  agcid: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .nullable()
    .default(null),
  sub: optional,
  session: optional,
  user_type: z.enum(USER_TYPES).or(z.literal('')).default(''),
  client: optional,
  fields: z.record(z.string(), z.unknown()).default({}),
});

export type Event = z.infer<typeof EventSchema>;
