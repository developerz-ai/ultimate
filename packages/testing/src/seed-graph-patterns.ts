// The `matches(/…/)` patterns an entity declares, per property. Read back from each invariant's
// own CHECK text, which `expr.ts` builds as `<column> ~ <literal(source)>` (or `btrim(<column>)`,
// `~*` for `/i`) — the same source `pattern.test` runs, so nothing here is a guess. A rule of any
// other shape (`iff`, a predicate, two columns) is not a pattern and is skipped.

import type { SeedEntity } from './seed-graph-shape';

/** `col ~ E'src'` / `btrim(col) ~* 'src'`: the whole CHECK, one column, one quoted literal. */
const PATTERN_CHECK = /^(?:btrim\(([a-z_][a-z0-9_$]*)\)|([a-z_][a-z0-9_$]*)) (~\*?) (E?)'(.*)'$/s;

/**
 * The `RegExp` one CHECK enforces on `column`, or `undefined`. The literal is undone exactly as
 * `@ultimat3/db`'s `literal()` made it: `''` is one quote, and under `E'…'` `\\` is one backslash.
 */
export function patternOfCheck(sql: string, column: string): RegExp | undefined {
  const match = PATTERN_CHECK.exec(sql);
  if (match === null || (match[1] ?? match[2]) !== column) return undefined;
  const body = match[5] ?? '';
  // A lone quote inside the body is not something `literal()` writes: not this shape after all.
  if (body.replaceAll("''", '').includes("'")) return undefined;
  const unquoted = body.replaceAll("''", "'");
  const source = match[4] === 'E' ? unquoted.replaceAll('\\\\', '\\') : unquoted;
  try {
    return new RegExp(source, match[3] === '~*' ? 'i' : '');
  } catch {
    // A source JavaScript cannot compile is no pattern to sample from; the solver still judges
    // every candidate by the rule itself, so skipping it loses a hint and never a check.
    return undefined;
  }
}

/** Property -> the patterns its `check` invariants declare. Empty for an entity with none. */
export function declaredPatterns(
  entity: Pick<SeedEntity, '$invariants' | '$describe'>,
): ReadonlyMap<string, readonly RegExp[]> {
  const propertyOf = new Map(
    entity.$describe().columns.map((column) => [column.column, column.property] as const),
  );
  const out = new Map<string, RegExp[]>();
  for (const invariant of entity.$invariants) {
    const [column] = invariant.columns;
    if (invariant.kind !== 'check' || invariant.sql === null || invariant.columns.length !== 1) {
      continue;
    }
    const property = column === undefined ? undefined : propertyOf.get(column);
    const pattern = column === undefined ? undefined : patternOfCheck(invariant.sql, column);
    if (property === undefined || pattern === undefined) continue;
    out.set(property, [...(out.get(property) ?? []), pattern]);
  }
  return out;
}
