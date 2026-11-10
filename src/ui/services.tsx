import { pct, serviceReasons, services, type Group, type Service } from './rules.js';
import { mapLoad, Table, useTools, type Row } from './table.js';

const COLS = {
  'extension/part': 0,
  calls: 6,
  'error %': 7,
  'p95 worst route': 15,
  availability: 12,
};
const avail = (s: Service) => pct(s.availability === null ? null : 100 * s.availability, 2);

const serviceRow = (s: Service): Row => ({
  key: `${s.extension}/${s.part}`,
  reasons: serviceReasons(s),
  cells: [
    `${s.extension}/${s.part}`,
    String(s.calls),
    pct(s.calls ? (100 * s.failed) / s.calls : 0),
    `${Math.round(s.p95)} ms`,
    avail(s),
  ],
});

interface Groups {
  groups: Group[];
  meta: { truncated: boolean };
}
const NOTE = 'truncated: more than 1000 groups; narrow by extension';
// Per kind: the sums per part, then the routes worst p95 first, so a cut never loses a part's worst.
const day = { since: '24h', limit: '1000' };
const CALLS = ['http', 'mcp'].flatMap((kind) => [
  { kind, by: 'extension,part', ...day },
  { kind, by: 'extension,part,route', sort: 'p95', ...day },
]);
const rowsOf = (answers: Groups[]) => {
  const [http, httpRoutes, mcp, mcpRoutes] = answers.map((a) => a.groups);
  return services([...(http ?? []), ...(mcp ?? [])], [...(httpRoutes ?? []), ...(mcpRoutes ?? [])]);
};

// logs__aggregate, not GET /stats: the bridge drops meta, the tool's meta says the groups were cut.
export function Services() {
  const load = useTools<Groups>('logs__aggregate', CALLS);
  const rows = mapLoad(load, (answers) => rowsOf(answers).map(serviceRow));
  const cut = load.state === 'ready' && load.data.some((a) => a.meta.truncated);
  return <Table caption={`services, 24 h${cut ? `, ${NOTE}` : ''}`} cols={COLS} load={rows} />;
}
