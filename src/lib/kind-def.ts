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

// One kind's table, or a list's: the members' rows together, their by names and kind.
export const defOf = (kind: string): KindDef | undefined => {
  const names = kindsOf(kind);
  if (!names.every(isKind)) return undefined;
  const defs = names.map((name) => KIND_DEFS[name]);
  const [first, ...rest] = defs;
  if (!first || rest.some((def) => !same(def.measures, first.measures))) return undefined;
  if (rest.length === 0) return first;
  const where = `(${defs.map((def) => def.where).join(' OR ')})`;
  return { ...first, where, by: Object.assign({}, ...defs.map((def) => def.by), { kind: 'kind' }) };
};

// name filters what by=name groups: the event name, or on container the container name.
export const NAME_RULE = 'name filters the kinds event, container and any (and a list with event)';
export const nameSql = (def: KindDef) =>
  def.by?.['name'] === undefined ? undefined : `${def.by['name']} = {name:String}`;

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
