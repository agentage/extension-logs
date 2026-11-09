import { useEffect, useState, type ReactNode } from 'react';
import { useHost } from '@agentage/widget';

export type Load<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: T; at: number };

// One GET per path; an answer for an older path reads as loading, never as this path's data.
export function useApi<T>(path: string): Load<T> {
  const { api } = useHost();
  const [got, setGot] = useState<{ path: string; load: Load<T> }>();
  useEffect(() => {
    let live = true;
    const set = (load: Load<T>) => live && setGot({ path, load });
    api(path).then(
      (data) => set({ state: 'ready', data: data as T, at: Date.now() }),
      (error: Error) => set({ state: 'error', message: error.message })
    );
    return () => void (live = false);
  }, [api, path]);
  return got?.path === path ? got.load : { state: 'loading' };
}

export interface Row {
  key: string;
  reasons: string[];
  cells: ReactNode[];
}

const CSS = `:host{display:block}table{width:100%;table-layout:fixed;border-collapse:collapse;font:var(--text-xs)/1.5 var(--font-mono,monospace);color:var(--color-foreground)}
caption{text-align:left;font-weight:600;padding:4px 0}th,td{text-align:left;padding:3px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid var(--color-border)}
tr.red td{color:var(--color-destructive);font-weight:600}tr.red td:first-child{box-shadow:inset 3px 0 var(--color-destructive)}
[title]{cursor:default}button{font:inherit;color:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}
.box{min-height:24em;overflow-x:auto}.bar{display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap}input,select{font:inherit}`;

const Note = ({ span, children, alert }: { span: number; children: string; alert?: boolean }) => (
  <tr>
    <td colSpan={span} role={alert ? 'alert' : undefined}>
      {children}
    </td>
  </tr>
);

const body = (load: Load<Row[]>, span: number) => {
  if (load.state === 'loading') return <Note span={span}>Loading...</Note>;
  if (load.state === 'error')
    return <Note span={span} alert>{`Could not load: ${load.message}`}</Note>;
  if (load.data.length === 0) return <Note span={span}>No rows</Note>;
  return load.data.map(({ key, reasons, cells }) => (
    <tr key={key} className={reasons.length > 0 ? 'red' : undefined}>
      <td title={reasons.join(', ') || undefined}>{reasons.length > 0 ? 'red' : 'ok'}</td>
      {cells.map((cell, i) => (
        <td key={i}>{cell}</td>
      ))}
    </tr>
  ));
};

// A table with a red rule; cols = name: width in ch, 0 takes the rest; the box keeps its size across states.
export const Table = ({
  caption,
  cols,
  load,
  min,
}: {
  caption: string;
  cols: Record<string, number>;
  load: Load<Row[]>;
  min?: string;
}) => (
  <div className="box">
    <style>{CSS}</style>
    <table style={{ minWidth: min }}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {Object.entries({ state: 5, ...cols }).map(([col, ch]) => (
            <th key={col} scope="col" style={ch ? { width: `calc(${ch}ch + 8px)` } : undefined}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body(load, Object.keys(cols).length + 1)}</tbody>
    </table>
  </div>
);

// at = when the answer came, so a row's age is read without a clock in render.
export const mapLoad = <T, U>(load: Load<T>, fn: (data: T, at: number) => U): Load<U> =>
  load.state === 'ready' ? { ...load, data: fn(load.data, load.at) } : load;

// The header of an opened row: a back button and what is open.
export const Back = ({ back, text }: { back: () => void; text: string }) => (
  <div className="bar">
    <button onClick={back}>back</button>
    <span>{text}</span>
  </div>
);
