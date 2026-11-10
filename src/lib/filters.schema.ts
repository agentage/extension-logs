import { z } from 'zod';
import { LEVELS, USER_TYPES } from '@agentage/extension/logs';

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/;
export const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
export const iso = (ts: unknown) => `${String(ts).replace(' ', 'T')}Z`;
const back = (s: string) => Number(s.slice(0, -1)) * UNIT[s.at(-1) as keyof typeof UNIT];

// 15m, 2h, 7d back from now, or an ISO time; ClickHouse reads it as DateTime64(3, 'UTC').
export const Since = z.union([
  z
    .string()
    .regex(/^\d{1,4}[mhd]$/)
    .transform((s) => stamp(new Date(Date.now() - back(s)))),
  z.iso.datetime({ offset: true }).transform((s) => stamp(new Date(s))),
]);

export const name = z.string().min(1).max(64);
export const Agcid = z.string().regex(/^[0-9a-f]{32}$/);
// A hostname: no slash, no '..', so a path segment never reads as another route.
export const Host = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,252}$/);
// The ingest's subject rule: an opaque id, never an email.
export const Sub = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Order = z.enum(['desc', 'asc']);

// The filters both reads take, besides kind and the window.
export const FILTER_FIELDS = {
  ...{ q: z.string().min(1).max(200).optional(), level: z.enum(LEVELS).optional() },
  ...{ extension: name.optional(), part: name.optional(), host: Host.optional() },
  ...{ agcid: Agcid.optional(), sub: Sub.optional(), route: z.string().min(1).max(200).optional() },
  status: z.coerce.number().int().min(0).max(65_535).optional(),
};
export const USER_TYPE = z.enum(USER_TYPES);
