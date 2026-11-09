import { useState } from 'react';
import type { z } from 'zod';
import type * as O from '../lib/outputs.schema.js';
import { clock } from './rules.js';
import { Back, mapLoad, Table, useApi, type Row } from './table.js';

type Event = z.output<typeof O.EventOutSchema>;
type Trace = z.output<typeof O.TraceOutSchema>;
const LEVELS = ['', 'info', 'warn', 'error'];
const EVENT_COLS = { ts: 8, level: 5, 'extension/part': 13, kind: 5, msg: 0, agcid: 12 };
// ?q= on the page prefills the search, so a link can open one agcid's rows.
const urlQ = () =>
  new URLSearchParams((globalThis as { location?: { search: string } }).location?.search).get('q');

const row = (e: Event, open?: (agcid: string) => void): Row => ({
  key: e.id,
  reasons: e.level === 'error' ? ['level error'] : [],
  cells: [
    clock(e.ts),
    e.level,
    `${e.extension}/${e.part}`,
    e.kind,
    <span title={e.msg}>{e.msg}</span>,
    e.agcid && open ? (
      <button onClick={() => open(e.agcid ?? '')}>{e.agcid.slice(0, 12)}</button>
    ) : (
      e.agcid
    ),
  ],
});

function TraceList({ agcid, back }: { agcid: string; back: () => void }) {
  const load = useApi<Trace>(`/traces/${agcid}`);
  const head =
    load.state === 'ready'
      ? `${load.data.hops} hops · ${load.data.ms} ms · ${load.data.ok ? 'ok' : 'failed'}`
      : '';
  return (
    <>
      <Back back={back} text={`agcid ${agcid} ${head}`} />
      <Table
        caption="trace"
        cols={EVENT_COLS}
        min="720px"
        load={mapLoad(load, (t) => t.events.map((e) => row(e)))}
      />
    </>
  );
}

type Filter = { q: string; level: string; extension: string };
interface FiltersProps {
  filter: Filter;
  set: (filter: Filter) => void;
  seen: string[];
}

function Filters({ filter, set, seen }: FiltersProps) {
  const [q, setQ] = useState(filter.q);
  const pick = (key: 'level' | 'extension', options: string[]) => (
    <label>
      {`${key} `}
      <select value={filter[key]} onChange={(e) => set({ ...filter, [key]: e.target.value })}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o || 'all'}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="bar"
      role="search"
      onSubmit={(e) => (e.preventDefault(), set({ ...filter, q }))}
    >
      <label>
        {'search '}
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="msg or agcid"
        />
      </label>
      {pick('level', LEVELS)}
      {pick('extension', [...new Set(['', filter.extension, ...seen])].sort())}
    </form>
  );
}

export function Events() {
  const [filter, setFilter] = useState<Filter>({ q: urlQ() ?? '', level: '', extension: '' });
  const [agcid, setAgcid] = useState('');
  const query = new URLSearchParams(
    Object.entries({ ...filter, limit: '100' }).filter(([, v]) => v)
  );
  const load = useApi<Event[]>(`/events?${query}`);
  if (agcid) return <TraceList agcid={agcid} back={() => setAgcid('')} />;
  const seen = load.state === 'ready' ? load.data.map((e) => e.extension) : [];
  return (
    <>
      <Filters filter={filter} set={setFilter} seen={seen} />
      <Table
        caption="events, last 100"
        cols={EVENT_COLS}
        min="720px"
        load={mapLoad(load, (rows) => rows.map((e) => row(e, setAgcid)))}
      />
    </>
  );
}
