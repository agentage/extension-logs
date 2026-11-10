import { useState } from 'react';
import { clock, hostReasons, pct, type Host } from './rules.js';
import { Back, Link, mapLoad, Table, useApi, type Row } from './table.js';

interface Container {
  name: string;
  cpu: number | null;
  mem: number | null;
  limit: number | null;
}
const mb = (bytes: number | null) => (bytes === null ? '-' : `${Math.round(bytes / 1_048_576)} MB`);
const num = (value: number | null) => (value === null ? '-' : String(value));
const BOX_COLS = { name: 0, cpu: 6, mem: 7, limit: 7 };
const COLS = { host: 0, cpu: 4, mem: 4, disk: 4, load1: 5, containers: 10, at: 8 };
// The windows of 0.2: a host sampled in the last hour, a container in the last 5 minutes.
const HOSTS = '/stats?kind=host&by=host&since=1h&sort=host&order=asc&limit=1000';
const boxes = (host: string) =>
  `/stats?kind=container&host=${encodeURIComponent(host)}&by=name&since=5m&limit=1000`;

const containerRow = (c: Container): Row => ({
  key: c.name,
  reasons: [],
  cells: [c.name, pct(c.cpu), mb(c.mem), mb(c.limit)],
});

const hostRow = (h: Host, open: (host: string) => void): Row => ({
  key: h.host,
  reasons: hostReasons(h),
  cells: [
    <Link label={`containers of ${h.host}`} text={h.host} go={() => open(h.host)} />,
    ...[pct(h.cpu, 0), pct(h.mem, 0), pct(h.disk, 0), num(h.load1), num(h.containers), clock(h.at)],
  ],
});

function Containers({ host, back }: { host: string; back: () => void }) {
  const load = useApi<Container[]>(boxes(host));
  const rows = mapLoad(load, (list) => list.map(containerRow));
  return (
    <>
      <Back back={back} text={`containers on ${host}`} />
      <Table caption={`containers on ${host}, by cpu`} cols={BOX_COLS} load={rows} />
    </>
  );
}

export function Hosts() {
  const [host, setHost] = useState('');
  const load = useApi<Host[]>(HOSTS);
  if (host) return <Containers host={host} back={() => setHost('')} />;
  const rows = mapLoad(load, (list) => list.map((h) => hostRow(h, setHost)));
  return <Table caption="hosts" cols={COLS} load={rows} />;
}
