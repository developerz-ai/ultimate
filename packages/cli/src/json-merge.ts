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
