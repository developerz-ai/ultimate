// Which records of some types moved, without holding any of them. A whole-type `useRecords` is the
// way to SHOW every record of a type, and holding the type is its price: none of its rows is
// evicted while the reader lives. A reader that only wants to know THAT something moved — re-render
// a server page, flash a counter — pays nothing here: it holds no row and no type.

import { pageStore } from './page-store';
import { isServerRender } from './reactivity';

/** Per type, the keys of its records that one store update moved (written, removed or evicted). */
export type RecordChanges = ReadonlyMap<string, readonly string[]>;

/** The listener's undo — call it, `release()` it or `using` it (Solid: `onCleanup`). */
export type RecordChangesHandle = (() => void) & { release(): void; [Symbol.dispose](): void };

const nothing = (): void => undefined;

/**
 * Calls `listener` once per store update that moved at least one record of `types`, with what
 * moved, grouped by type. Holds nothing: a record no other reader holds is evicted as before.
 */
export function useRecordChanges(
  types: readonly string[],
  listener: (changed: RecordChanges) => void,
): RecordChangesHandle {
  if (isServerRender())
    return Object.assign(nothing, { release: nothing, [Symbol.dispose]: nothing });
  const watched = new Set(types);
  const unsubscribe = pageStore('useRecordChanges').subscribe((changed) => {
    const moved = new Map<string, string[]>();
    for (const rk of changed) {
      const at = rk.indexOf(':');
      const type = rk.slice(0, at);
      if (!watched.has(type)) continue;
      const keys = moved.get(type) ?? [];
      keys.push(rk.slice(at + 1));
      moved.set(type, keys);
    }
    if (moved.size > 0) listener(moved);
  });
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    unsubscribe();
  };
  return Object.assign(release, { release, [Symbol.dispose]: release });
}
