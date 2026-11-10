import { EventSchema, parseLine, type Event } from '@agentage/extension/logs';

const DAY = 86_400_000;
// Inside the TTL and at most an hour ahead: one row outside would fail its whole batch insert.
const recent = ({ ts }: Event) => {
  const at = Date.parse(ts);
  return at >= Date.now() - 30 * DAY && at <= Date.now() + DAY / 24;
};
// The ingest's two rules on top of the line: the TTL window and an opaque id subject, never an email.
const SUB = /^[A-Za-z0-9_-]{1,64}$/;
const LineSchema = EventSchema.refine(recent, 'ts outside the last 30 days').refine(
  ({ sub }) => sub === null || SUB.test(sub),
  'sub is not an opaque id'
);

const RAW_ERROR = /ERROR|FATAL/;

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
  // The package's redaction on a valid line: secret keys and credential values masked, cut on a code point.
  const event = raw(parseLine(JSON.stringify(parsed.data)));
  return { ...event, host: event.host ?? '', client: event.client ?? '', ...promote(event) } as Row;
};
