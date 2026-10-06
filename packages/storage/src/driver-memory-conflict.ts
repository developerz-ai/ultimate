// Single responsibility: which stored key stands in the way of a new one, answered over a set of
// keys exactly as `driver-local-write.ts`'s `claim()` answers it over a directory tree — so the
// memory disk refuses the keys the local disk it stands in for cannot hold.

import { pendingPathOf, sidecarPathOf } from './driver-local-write';
import { META_DIR } from './path';

/** `.meta/<key>.json` → `<key>.json`: the sidecar tree, read as keys. */
const inSidecarTree = (relative: string): string => relative.slice(META_DIR.length + 1);

/** Every proper ancestor directory of `path`, shallowest first: what `mkdir -p` would make. */
const ancestorsOf = (path: string): readonly string[] => {
  const segments = path.split('/').slice(0, -1);
  return segments.map((_, depth) => segments.slice(0, depth + 1).join('/'));
};

/**
 * The key in the way of storing `key`, spelled as the local disk's `X_STORAGE_KEY_CONFLICT` spells
 * it (`blocking`), or `undefined`. Checked in `claim()`'s order — the object path, its sidecar,
 * its pending marker — each first for a FILE where a directory must be, then for a DIRECTORY
 * where the file must go. A marker is transient (cleared on commit), so it is never in the way of
 * a later key; a directory where one must be written still is.
 */
export function keyInTheWay(stored: ReadonlyMap<string, unknown>, key: string): string | undefined {
  // Object tree: `a` stored blocks `a/b`; `c/d` stored blocks `c` (reported as `c/`).
  for (const ancestor of ancestorsOf(key)) if (stored.has(ancestor)) return ancestor;
  const beneath = (prefix: string): boolean => {
    for (const other of stored.keys()) if (other.startsWith(prefix)) return true;
    return false;
  };
  if (beneath(`${key}/`)) return `${key}/`;
  // Sidecar tree: `.meta/<k>.json` is a FILE per stored key `k`, and its directories are the
  // object tree's — so `s` stored blocks `s.json/x`, and `t.json/x` stored blocks `t`.
  const sidecar = inSidecarTree(sidecarPathOf(key));
  for (const ancestor of ancestorsOf(sidecar)) {
    if (ancestor.endsWith('.json') && stored.has(ancestor.slice(0, -'.json'.length))) {
      return ancestor.slice(0, -'.json'.length);
    }
  }
  if (beneath(`${sidecar}/`)) return `${sidecar}/`;
  const pending = inSidecarTree(pendingPathOf(key));
  // `<k>.json.pending/` is a directory exactly when a key's sidecar lives beneath it.
  if (beneath(`${pending}/`)) return `${pending}/`;
  return undefined;
}
