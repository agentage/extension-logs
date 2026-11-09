import { pct, serviceReasons, services, type Stat } from './rules.js';
import { mapLoad, Table, useApi } from './table.js';

export function Services() {
  const load = useApi<Stat[]>('/stats?window=24h');
  const rows = mapLoad(load, (stats) =>
    services(stats).map((s) => ({
      key: `${s.extension}/${s.part}`,
      reasons: serviceReasons(s),
      cells: [
        `${s.extension}/${s.part}`,
        String(s.calls),
        pct(s.calls ? (100 * s.errors) / s.calls : 0),
        `${Math.round(s.p95)} ms`,
        pct(s.availability === null ? null : 100 * s.availability, 2),
      ],
    }))
  );
  return (
    <Table
      caption="services, 24 h"
      cols={{ 'extension/part': 0, calls: 6, 'error %': 7, p95: 7, availability: 12 }}
      load={rows}
    />
  );
}
