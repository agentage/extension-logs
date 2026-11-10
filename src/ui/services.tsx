import { pct, serviceReasons, services, type Service, type Stat } from './rules.js';
import { mapLoad, Table, useTool, type Row } from './table.js';

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
    pct(s.calls ? (100 * s.errors) / s.calls : 0),
    `${Math.round(s.p95)} ms`,
    avail(s),
  ],
});

// logs__stats, not GET /stats: the bridge drops meta, the tool's note says the rows were cut.
export function Services() {
  const load = useTool<{ stats?: Stat[]; note?: string }>('logs__stats', { window: '24h' });
  const rows = mapLoad(load, ({ stats = [] }) => services(stats).map(serviceRow));
  const note = load.state === 'ready' && load.data.note ? `, ${load.data.note}` : '';
  return <Table caption={`services, 24 h${note}`} cols={COLS} load={rows} />;
}
