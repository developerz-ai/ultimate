// A pins module read as rows: `<export>.<row>` → the debt that row allows. Every ratchet table
// under `scripts/lib/*-pins.ts` is pure data in one of five shapes, and this is the one reader that
// flattens all five, so `pin-raises` can compare two versions of any table without knowing it.

/** A number is a count; a `{ count }` row is its count; any other row is a licence, worth 1. */
const debtOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return 1;
  if (typeof value !== 'object' || value === null) return undefined;
  const count: unknown = Reflect.get(value, 'count');
  return typeof count === 'number' ? count : 1;
};

/** The identity of an array row: its `pkg`, else every string field that is not prose. */
const arrayKeyOf = (row: unknown, index: number): string => {
  if (typeof row !== 'object' || row === null) return String(index);
  const pkg: unknown = Reflect.get(row, 'pkg');
  if (typeof pkg === 'string') return pkg;
  const parts = Object.entries(row)
    .filter(([key, value]) => typeof value === 'string' && key !== 'reason' && key !== 'why')
    .map(([, value]) => String(value));
  return parts.length === 0 ? String(index) : parts.join(' ');
};

/** Every row of every table the module exports. A function or a scalar export is not a table. */
export function pinRows(module: Readonly<Record<string, unknown>>): ReadonlyMap<string, number> {
  const rows = new Map<string, number>();
  for (const [name, table] of Object.entries(module)) {
    if (typeof table !== 'object' || table === null) continue;
    const entries: [string, unknown][] = Array.isArray(table)
      ? table.map((row: unknown, index) => [arrayKeyOf(row, index), row])
      : Object.entries(table);
    for (const [key, value] of entries) {
      const debt = debtOf(value);
      if (debt !== undefined) rows.set(`${name}.${key}`, debt);
    }
  }
  return rows;
}

const RELATIVE_SPECIFIER = /(\bfrom\s*['"])(\.{1,2}\/[^'"]+)(['"])/g;

/**
 * A module's exports, read from source text by importing a temporary copy of it. `from` is the
 * absolute path the text belongs to: the copy lives in a scratch directory, so a RELATIVE import in
 * it (`coverage-pins.ts` reads its bar from `packages/cli/src/coverage-floor`) is rewritten to the
 * absolute path it meant — left alone it resolved against the scratch directory and the load
 * crashed with "Cannot find module", taking every table's comparison down with it.
 */
export async function importPinSource(
  source: string,
  scratch: string,
  from: string,
): Promise<Readonly<Record<string, unknown>>> {
  const anchored = source.replace(
    RELATIVE_SPECIFIER,
    (_, open: string, specifier: string, close: string) =>
      `${open}${new URL(specifier, `file://${from}`).pathname}${close}`,
  );
  const path = `${scratch}/pins-${Bun.hash(anchored).toString(16)}.ts`;
  await Bun.write(path, anchored);
  const loaded: unknown = await import(path);
  return typeof loaded === 'object' && loaded !== null ? { ...loaded } : {};
}
