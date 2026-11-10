import { useState } from 'react';
import type { z } from 'zod';
import type * as O from '../lib/outputs.schema.js';
import { clock, traceHead } from './rules.js';
import { Back, Link, mapLoad, Table, useApi, useApis, type Row } from './table.js';

type Event = z.output<typeof O.EventOutSchema>;
type Filter = { q: string; level: string; extension: string };
const LEVELS = ['', 'info', 'warn', 'error'];
const COLS = { ts: 8, level: 5, 'extension/part': 14, kind: 5, msg: 0, agcid: 12 };

const agcidCell = (agcid: string | null, open?: (agcid: string) => void) =>
  agcid && open ? <Link label={`trace ${agcid}`} text={agcid} go={() => open(agcid)} /> : agcid;

const row = (e: Event, open?: (agcid: string) => void): Row => ({
  key: e.id,
  reasons: e.level === 'error' ? ['error'] : [],
  cells: [
    clock(e.ts),
    e.level,
    `${e.extension}/${e.part}`,
    e.kind,
    <span title={e.msg}>{e.msg}</span>,
    agcidCell(e.agcid, open),
  ],
});

// One agcid in time order over the table's 30 days.
const traceOf = (agcid: string) =>
  `/events?agcid=${encodeURIComponent(agcid)}&order=asc&since=30d&limit=1000`;

function TraceList({ agcid, back }: { agcid: string; back: () => void }) {
  const load = useApi<Event[]>(traceOf(agcid));
  const rows = mapLoad(load, (events) => events.map((e) => row(e)));
  const head = load.state === 'ready' ? traceHead(load.data) : '';
  return (
    <>
      <Back back={back} text={`agcid ${agcid}${head}`} />
      <Table caption="trace" cols={COLS} rest={32} load={rows} />
    </>
  );
}

interface FilterProps {
  filter: Filter;
  set: (filter: Filter) => void;
}
type PickProps = FilterProps & { name: 'level' | 'extension'; options: string[] };

const Pick = ({ name, options, filter, set }: PickProps) => (
  <label>
    {`${name} `}
    <select value={filter[name]} onChange={(e) => set({ ...filter, [name]: e.target.value })}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o || 'all'}
        </option>
      ))}
    </select>
  </label>
);

// The extension options are every extension with requests or tool calls in 24 h.
const KNOWN = ['http', 'mcp'].map(
  (kind) => `/stats?kind=${kind}&by=extension&since=24h&limit=1000`
);
const useExtensions = (selected: string) => {
  const load = useApis<{ extension: string }[]>(KNOWN);
  const known = load.state === 'ready' ? load.data.flat().map((s) => s.extension) : [];
  return [...new Set(['', selected, ...known])].sort();
};

const Search = ({ q, type }: { q: string; type: (value: string) => void }) => (
  <label>
    {'search '}
    <input
      type="search"
      value={q}
      onChange={(e) => type(e.target.value)}
      placeholder="msg or agcid"
    />
  </label>
);

function Filters({ filter, set }: FilterProps) {
  const [q, setQ] = useState(filter.q);
  const extensions = useExtensions(filter.extension);
  const type = (value: string) => (setQ(value), value === '' && set({ ...filter, q: '' }));
  return (
    <form
      className="bar"
      role="search"
      onSubmit={(e) => (e.preventDefault(), set({ ...filter, q }))}
    >
      <Search q={q} type={type} />
      <Pick name="level" options={LEVELS} filter={filter} set={set} />
      <Pick name="extension" options={extensions} filter={filter} set={set} />
    </form>
  );
}

const search = (filter: Filter) =>
  new URLSearchParams(Object.entries({ ...filter, limit: '100' }).filter(([, v]) => v));

export function Events() {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const [filter, setFilter] = useState<Filter>({ q, level: '', extension: '' });
  const [agcid, setAgcid] = useState('');
  const load = useApi<Event[]>(`/events?${search(filter)}`);
  if (agcid) return <TraceList agcid={agcid} back={() => setAgcid('')} />;
  const rows = mapLoad(load, (list) => list.map((e) => row(e, setAgcid)));
  return (
    <>
      <Filters filter={filter} set={setFilter} />
      <Table caption="events, last 100" cols={COLS} rest={32} load={rows} />
    </>
  );
}
