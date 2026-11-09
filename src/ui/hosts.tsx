import { useState } from 'react';
import type { z } from 'zod';
import type * as O from '../lib/outputs.schema.js';
import { clock, hostReasons, pct, type Host } from './rules.js';
import { Back, mapLoad, Table, useApi } from './table.js';

type Container = z.output<typeof O.ContainerOutSchema>;
const mb = (bytes: number | null) => (bytes === null ? '-' : `${Math.round(bytes / 1_048_576)} MB`);
const num = (value: number | null) => (value === null ? '-' : String(value));

function Containers({ host, back }: { host: string; back: () => void }) {
  const load = useApi<Container[]>(`/hosts/${encodeURIComponent(host)}/containers`);
  const rows = mapLoad(load, (list) =>
    list.map((c) => ({
      key: c.name,
      reasons: [],
      cells: [c.name, pct(c.cpu), mb(c.mem), mb(c.limit)],
    }))
  );
  return (
    <>
      <Back back={back} text={`containers on ${host}`} />
      <Table
        caption={`containers on ${host}, by cpu`}
        cols={{ name: 0, cpu: 6, mem: 7, limit: 7 }}
        load={rows}
      />
    </>
  );
}

export function Hosts() {
  const [host, setHost] = useState('');
  const load = useApi<Host[]>('/hosts');
  if (host) return <Containers host={host} back={() => setHost('')} />;
  const rows = mapLoad(load, (list, now) =>
    list.map((h) => ({
      key: h.host,
      reasons: hostReasons(h, now),
      cells: [
        <button onClick={() => setHost(h.host)}>{h.host}</button>,
        pct(h.cpu, 0),
        pct(h.mem, 0),
        pct(h.disk, 0),
        num(h.load1),
        num(h.containers),
        clock(h.at),
      ],
    }))
  );
  return (
    <Table
      caption="hosts"
      cols={{ host: 0, cpu: 4, mem: 4, disk: 4, load1: 5, containers: 10, at: 8 }}
      load={rows}
    />
  );
}
