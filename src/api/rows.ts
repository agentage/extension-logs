import { EventSchema, type Event } from '@agentage/extension/logs';

const DAY = 86_400_000;
// Inside the TTL and at most an hour ahead: one row outside would fail its whole batch insert.
const recent = ({ ts }: Event) => {
  const at = Date.parse(ts);
  return at >= Date.now() - 30 * DAY && at <= Date.now() + DAY / 24;
};
// The ingest's two rules on top of the line: the TTL window and a usr_ or svc_ subject, never an email.
const SUB = /^(usr|svc)_[\w-]{1,64}$/;
const LineSchema = EventSchema.refine(recent, 'ts outside the last 30 days').refine(
  ({ sub }) => sub === null || SUB.test(sub),
  'sub is not usr_ or svc_'
);

const SECRET_KEY = /token|secret|password|key|authorization|cookie/i;
const MAX_STRING = 200;
const MAX_DEPTH = 3;
const RAW_ERROR = /ERROR|FATAL/;

// The package's redaction, applied again: secret keys hidden, strings cut, depth capped.
export const redact = (value: unknown, depth = 1): unknown => {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1),
    ])
  );
};

// A raw line (a container the kit does not run): a log row, no agcid, level from its text.
const raw = (event: Event): Event =>
  event.fields['agentage.raw'] !== true
    ? event
    : { ...event, kind: 'log', agcid: null, level: RAW_ERROR.test(event.msg) ? 'error' : 'info' };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), 0), max)
    : 0;

const okOf = (event: Event, status: number): boolean => {
  if (event.kind === 'http') return status < 500;
  if (event.kind === 'mcp' || event.kind === 'job') return event.fields['error.type'] === undefined;
  return event.level !== 'error';
};

// The hot columns, read from fields; the ingest derives nothing else.
const promote = (event: Event) => {
  const f = event.fields;
  const status = count(f['http.response.status_code'], 65_535);
  const route = event.kind === 'mcp' ? f['gen_ai.tool.name'] : f['http.route'];
  return {
    method: text(f['http.request.method']),
    route: text(route),
    status,
    ms: count(f['agentage.duration_ms'], 4_294_967_295),
    ok: okOf(event, status),
  };
};

export type Row = Event & ReturnType<typeof promote>;

// One line to one row, or null when it fails the schema.
export const toRow = (line: unknown): Row | null => {
  const parsed = LineSchema.safeParse(line);
  if (!parsed.success) return null;
  const fields = redact(parsed.data.fields) as Event['fields'];
  const event = raw({ ...parsed.data, msg: parsed.data.msg.slice(0, MAX_STRING), fields });
  return { ...event, host: event.host ?? '', client: event.client ?? '', ...promote(event) } as Row;
};
