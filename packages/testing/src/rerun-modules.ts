// Which modules evaluated between two points of one test file, and what they export: how the
// rerun seam tells a declaration a test made from one a module it imported made, since a module
// evaluates once per process and a rerun's `await import()` of it declares nothing.

/** The process's evaluated modules at one instant, and what the ones after it export. */
export interface ModuleLedger {
  /** Every module evaluated so far, ESM included. ~1 ms at 2,700: read once per file, then on a gain. */
  snapshot(): ReadonlySet<string>;
  /** Every value the modules evaluated since `before` export — arrays one level deep. */
  exportsSince(before: ReadonlySet<string>, self: string): readonly unknown[];
}

/**
 * The namespace the cache already holds for `key`. Never `require(key)`: on a `?x-reload=` entry a
 * loader plugin made, that goes back through the plugin, whose async read of a fixture app since
 * deleted was an unhandled ENOENT at the file's end (`serve-web.test.ts`).
 */
const namespaceOf = (key: string): unknown => {
  try {
    return require.cache[key]?.exports;
  } catch {
    // An entry whose namespace cannot be read (one still evaluating) exports nothing this seam
    // could match a declaration to.
    return undefined;
  }
};

const valuesOf = (namespace: unknown): readonly unknown[] => {
  if (namespace === null || typeof namespace !== 'object') return [];
  const values: unknown[] = [];
  for (const value of Object.values(namespace)) {
    values.push(value);
    if (Array.isArray(value)) values.push(...value);
  }
  return values;
};

export const processModules: ModuleLedger = {
  snapshot: () => new Set(Object.keys(require.cache)),
  exportsSince(before, self) {
    const values: unknown[] = [];
    for (const key of Object.keys(require.cache)) {
      // The test file enters the cache once its body is done: its exports are its own.
      if (before.has(key) || key === self) continue;
      values.push(...valuesOf(namespaceOf(key)));
    }
    return values;
  },
};
