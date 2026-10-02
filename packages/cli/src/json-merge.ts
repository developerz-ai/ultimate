// The one union behind every `merge: 'json'` generated file. Deep, because a catalog is authored
// nested (`{ site: { home: { title } } }`) — a shallow spread of two generators' contributions
// under the same top-level key drops one of them entirely, and neither generator can see the other.

/** A parsed JSON object: the only shape a `merge: 'json'` file is ever allowed to hold. */
export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `incoming` merged under `held`, leaf by leaf. `held` always wins — on disk it is the file a
 * human may have translated, and in `dedupe` it is the contribution that got there first — so a
 * merge only ever *adds* keys. A branch meeting a leaf is the same conflict either direction:
 * `held` keeps its shape, because overwriting it is the data loss this never does.
 *
 * `gained` is whether anything was actually added, so a caller can leave a file untouched rather
 * than rewrite it byte-identically and claim it as written.
 */
export function mergeJsonDeep(
  held: JsonObject,
  incoming: JsonObject,
): { merged: JsonObject; gained: boolean } {
  const merged: JsonObject = { ...held };
  let gained = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(held, key)) {
      merged[key] = value;
      gained = true;
      continue;
    }
    const current = held[key];
    if (!isObject(current) || !isObject(value)) continue;
    const nested = mergeJsonDeep(current, value);
    if (!nested.gained) continue;
    merged[key] = nested.merged;
    gained = true;
  }
  return { merged, gained };
}

/** Code units, never `localeCompare`: the bytes must not move with the machine's ICU. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isSorted = (keys: readonly string[]): boolean =>
  keys.every((key, index) => index === 0 || byCodeUnit(keys[index - 1] ?? '', key) <= 0);

/** Every key of every level, sorted — the order a generator's own fresh output is written in. */
export function sortJsonDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonDeep);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(byCodeUnit)
      .map((key) => [key, sortJsonDeep(value[key])]),
  );
}

/**
 * `mergeJsonDeep`, for a file that is ALREADY ON DISK: the same union, written back in the order
 * the file is in. A catalog a team keeps grouped by screen was re-sorted wholesale by a merge
 * that sorted every level — 424 changed lines for 22 added keys — which buries the keys a run
 * added and turns every generator run into a merge conflict.
 *
 * Per level: a held key stays where it is. A new key takes its SORTED place when that level is
 * sorted already — which is every level a generator wrote, so two runs in either order still write
 * the same bytes — and goes to the END, in sorted order among the new ones, when it is not. A
 * wholly new subtree is the generator's own and arrives sorted.
 */
export function mergeJsonInPlace(held: JsonObject, incoming: JsonObject): JsonObject {
  const heldKeys = Object.keys(held);
  const added = Object.keys(incoming)
    .filter((key) => !Object.hasOwn(held, key))
    .sort(byCodeUnit);
  const order = isSorted(heldKeys)
    ? [...heldKeys, ...added].sort(byCodeUnit)
    : [...heldKeys, ...added];
  return Object.fromEntries(
    order.map((key) => {
      if (!Object.hasOwn(held, key)) return [key, sortJsonDeep(incoming[key])];
      const current = held[key];
      const next = incoming[key];
      return [key, isObject(current) && isObject(next) ? mergeJsonInPlace(current, next) : current];
    }),
  );
}
