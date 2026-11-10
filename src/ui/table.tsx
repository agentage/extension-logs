import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useHost } from '@agentage/widget';

export type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

// One call per key; an answer for an older key reads as loading, never as this key's data.
function useLoad<T>(path: string, call: () => Promise<unknown>): Load<T> {
  const [got, setGot] = useState<{ path: string; load: Load<T> }>();
  useEffect(() => {
    let live = true;
    const set = (load: Load<T>) => live && setGot({ path, load });
    call().then(
      (data) => set({ state: 'ready', data: data as T }),
      // A host error has a code (401, 403, 503, timeout); a bare one is the network itself.
      (error: Error & { code?: string }) =>
        set({ state: 'error', message: error.code ? error.message : 'the network failed' })
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the call
  }, [path]);
  return got?.path === path ? got.load : { state: 'loading' };
}

export function useApi<T>(path: string): Load<T> {
  const { api } = useHost();
  return useLoad<T>(path, () => api(path));
}

export function useTool<T>(name: string, args: Record<string, string>): Load<T> {
  const { tool } = useHost();
  return useLoad<T>(`${name} ${JSON.stringify(args)}`, () => tool(name, args));
}

export const mapLoad = <T, U>(load: Load<T>, fn: (data: T) => U): Load<U> =>
  load.state === 'ready' ? { state: 'ready', data: fn(load.data) } : load;

export interface Row {
  key: string;
  reasons: string[];
  cells: ReactNode[];
}

const CSS = `:host{display:block}table{width:100%;table-layout:fixed;border-collapse:collapse;font:var(--text-xs)/1.5 var(--font-mono,monospace);color:var(--color-foreground)}
caption{text-align:left;font-weight:600;padding:4px 0}th,td{text-align:left;padding:3px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid var(--color-border)}
tr.red td{color:var(--color-destructive);font-weight:600}tr.red td:first-child{box-shadow:inset 3px 0 var(--color-destructive)}
[title]{cursor:default}button{font:inherit;color:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.box{min-height:24em;overflow-x:auto}.bar{display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap}input,select{font:inherit}h3{font:inherit;margin:0}`;

const Note = ({ span, text, alert }: { span: number; text: string; alert?: boolean }) => (
  <tr>
    <td colSpan={span}>
      <span role={alert ? 'alert' : undefined}>{text}</span>
    </td>
  </tr>
);

// The state cell says why a row is red, as text.
const Line = ({ reasons, cells }: Row) => (
  <tr className={reasons.length > 0 ? 'red' : undefined}>
    <td>{reasons.join(', ') || 'ok'}</td>
    {cells.map((cell, i) => (
      <td key={i}>{cell}</td>
    ))}
  </tr>
);

const body = (load: Load<Row[]>, span: number) => {
  if (load.state === 'loading') return <Note span={span} text="Loading..." />;
  if (load.state === 'error')
    return <Note span={span} text={`Could not load: ${load.message}`} alert />;
  if (load.data.length === 0) return <Note span={span} text="No rows" />;
  return load.data.map((row) => <Line {...row} key={row.key} />);
};

interface TableProps {
  caption: string;
  cols: Record<string, number>;
  load: Load<Row[]>;
  min?: string;
}

// cols = name: width in ch, 0 takes the rest; the box keeps its size across the three states.
export const Table = ({ caption, cols, load, min }: TableProps) => (
  <div className="box">
    <style>{CSS}</style>
    <table style={{ minWidth: min }}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {Object.entries({ state: 14, ...cols }).map(([col, ch]) => (
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

// An opened row: a back button, and its heading takes the focus.
export const Back = ({ back, text }: { back: () => void; text: string }) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="bar">
      <button onClick={back}>back</button>
      <h3 ref={heading} tabIndex={-1}>
        {text}
      </h3>
    </div>
  );
};

export const Link = ({ label, text, go }: { label: string; text: string; go: () => void }) => (
  <button aria-label={label} onClick={go}>
    {text}
  </button>
);
