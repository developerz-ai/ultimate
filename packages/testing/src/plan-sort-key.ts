// A Sort node's key, read as an index would have to hold it: which table each part belongs to,
// whether it is a plain column, and which way it runs. An index serves a sort only when every part
// is a plain column of ONE table, all running one way — anything else no `indexes:` entry ends.

/**
 * Why no index an entity declares can serve a sort: its key is an expression (`entity()` declares
 * no expression index), a value an aggregate or window computed, a value a subquery derived, the
 * columns of more than one table, or columns running in different directions.
 */
export type PlanUnservable = 'expression' | 'aggregate' | 'derived' | 'tables' | 'directions';

/** A column a sort key names, as the plan prints it: `p.created_at`, or `title` alone. */
export interface SortKeyRef {
  readonly qualifier: string | undefined;
  readonly name: string;
}

export interface SortKeyPart {
  /** The column, when the part is one column and nothing else. */
  readonly column: SortKeyRef | undefined;
  /** Every column the part names: the expression's too. */
  readonly refs: readonly SortKeyRef[];
  /** `up` is an ascending walk (nulls last), `down` the same walk backwards; `mixed` is neither. */
  readonly way: 'up' | 'down' | 'mixed';
}

const NAME = '"?([A-Za-z_][\\w$]*)"?';
const PLAIN = new RegExp(`^(?:${NAME}\\.)?${NAME}$`);
const REF = new RegExp(`(?:${NAME}\\.)?${NAME}`, 'g');

/**
 * One part of a `Sort Key`. Postgres prints `DESC` and a `NULLS` that differs from the direction's
 * default; ascending nulls last and descending nulls first are the two walks of one btree.
 */
export function sortKeyPart(key: string): SortKeyPart {
  let rest = key.trim();
  const nulls = /\s+NULLS\s+(FIRST|LAST)$/i.exec(rest);
  if (nulls !== null) rest = rest.slice(0, nulls.index);
  const desc = /\s+DESC$/i.test(rest);
  rest = rest.replace(/\s+(?:DESC|ASC)$/i, '');
  const nullsFirst = nulls === null ? desc : nulls[1]?.toUpperCase() === 'FIRST';
  const way = desc === nullsFirst ? (desc ? 'down' : 'up') : 'mixed';
  const plain = PLAIN.exec(rest);
  const refs = [...rest.replace(/'[^']*'/g, '').matchAll(REF)].flatMap(([, qualifier, name]) =>
    name === undefined ? [] : [{ qualifier, name }],
  );
  const column = plain?.[2] === undefined ? undefined : { qualifier: plain[1], name: plain[2] };
  return { column, refs, way };
}

/**
 * Why an index cannot serve these parts, given the table each column belongs to (`undefined` for
 * one the judged tables do not hold), or `undefined` when one index on one table could.
 */
export function sortUnservable(
  parts: readonly SortKeyPart[],
  tableOf: (ref: SortKeyRef) => string | undefined,
): PlanUnservable | undefined {
  if (parts.some((part) => part.column === undefined)) return 'expression';
  const tables = new Set(parts.flatMap((part) => (part.column ? [tableOf(part.column)] : [])));
  if (tables.size > 1) return 'tables';
  const ways = new Set(parts.map((part) => part.way));
  if (ways.has('mixed') || ways.size > 1) return 'directions';
  return undefined;
}
