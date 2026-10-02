// Single responsibility: an error's `meta` as a record `JSON.stringify` cannot throw on. The twin
// of `renderMetaRecord` in `packages/core/src/error-render.ts`, restated because this package is
// tier 0 and may not import core — `SchemaError.toJSON()` makes the same `--json` promise.

import { describeValue } from './describe-value';

type Meta = Readonly<Record<string, unknown>>;

/** `JSON.stringify` with its throw removed: did the value survive being serialised at all? */
function canRender(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/** A record's own keys, or none — a `Proxy` may refuse to be enumerated. */
function metaKeys(meta: Meta): readonly string[] {
  try {
    return Object.keys(meta);
  } catch {
    return [];
  }
}

/**
 * One entry, kept as it is when it serialises. What does not is DESCRIBED, never echoed: a schema
 * error's `meta` holds the value a caller sent, so `describeValue` — shape and length, no content —
 * is the only rendering this package has for one. A function is described too: `JSON.stringify`
 * drops it without throwing, but copying a `toJSON` across would have it invoked one layer out.
 */
function metaEntry(meta: Meta, key: string): unknown {
  try {
    const value = meta[key];
    return canRender(value) && typeof value !== 'function' ? value : describeValue(value);
  } catch {
    return 'a value that cannot be read';
  }
}

/**
 * `meta` is machine-read, so a record that serialises is returned UNCHANGED, identity included.
 * Only what cannot be rendered degrades, one key at a time — a `bigint` or a cycle in one entry
 * must not cost the reader the entries beside it, and must not throw at `--json` render time.
 */
export function renderMetaRecord(meta: Meta | undefined): Meta | undefined {
  if (meta === undefined || canRender(meta)) return meta;
  const out: Record<string, unknown> = {};
  for (const key of metaKeys(meta)) out[key] = metaEntry(meta, key);
  return out;
}
