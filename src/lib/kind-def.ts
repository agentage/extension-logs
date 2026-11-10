import {
  COLUMNS,
  KIND_DEFS,
  STATS_KINDS,
  type KindDef,
  type Measure,
  type StatsKind,
} from './kinds.js';

const isKind = (name: string): name is StatsKind =>
  (STATS_KINDS as readonly string[]).includes(name);
const kindsOf = (kind: string) => [...new Set(kind.split(','))];

const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

// One kind's table, or a list's: the members' rows together, the by names they share and kind.
export const defOf = (kind: string): KindDef | undefined => {
  const names = kindsOf(kind);
  if (!names.every(isKind)) return undefined;
  const [first, ...rest] = names.map((name) => KIND_DEFS[name]);
  if (!first || rest.some((def) => !same(def.measures, first.measures))) return undefined;
  if (rest.length === 0) return first;
  const where = `(${[first, ...rest].map((def) => def.where).join(' OR ')})`;
  const shared = Object.entries(first.by ?? {}).filter(([n, sql]) =>
    rest.every((def) => def.by?.[n] === sql)
  );
  return { ...first, where, by: { ...Object.fromEntries(shared), kind: 'kind' } };
};

// Why a kind is refused: a name outside the list, or a list whose kinds measure differently.
export const kindIssue = (kind: string) => {
  if (defOf(kind)) return undefined;
  const names = kindsOf(kind);
  if (!names.every(isKind)) return `kind takes ${STATS_KINDS.join(', ')}, or a comma list`;
  return `${names.join(' and ')} have different measures: a list takes kinds that share them, as http,mcp`;
};

// The measures of one call: under only when the call gives it.
export const measuresOf = (def: KindDef, under?: number): Record<string, Measure> =>
  under !== undefined && def.under ? { ...def.measures, under: def.under } : def.measures;

// The names a caller may group on, and the names it may sort on, for one kind.
export const byNames = (def: KindDef) => [...COLUMNS, ...Object.keys(def.by ?? {})];
export const sortNames = (def: KindDef, by: string[], bucket: boolean, under?: number) => [
  ...Object.keys(measuresOf(def, under)),
  ...by,
  ...(bucket ? ['bucket'] : []),
];
