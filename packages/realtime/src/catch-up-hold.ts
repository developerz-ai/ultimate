// A channel's catch-up read, held until this page's writes in flight over its record types are
// answered (#778): the read names no write, and its snapshot may already hold one whose twin is
// still on screen — adopted then, the like is counted twice until the write's answer or echo.
// The store bounds the hold (`afterWrites`); a row the server moved while it was held is left alone.

import type { Row } from '@ultimat3/core/page';
import type { CatchUpRecords } from './channel-catch-up';
import { recordKey } from './record-key';
import type { HeldLanding } from './record-landings';
import type { RecordStore } from './record-store';

/**
 * `land` gets the read once nothing blocks it, minus every COLUMN whose server truth moved
 * meanwhile: that value ARRIVED after the read did — a write's own answer, another subscription's
 * frame — and the store's rule is that the later arrival stands. A column nothing moved is still
 * the read's (the store merges by column: a narrower query moving `likes` says nothing of `title`).
 * A row gone since — removed, or evicted — is not brought back, and a removal is skipped for a row
 * that moved at all.
 */
export function holdCatchUp(
  store: RecordStore,
  answered: CatchUpRecords | undefined,
  echoed: () => Iterable<string>,
  land: (fresh: CatchUpRecords | undefined) => void,
): HeldLanding {
  if (answered === undefined) {
    land(undefined);
    return { recheck: () => undefined };
  }
  const seen = new Map<string, Row | undefined>();
  const types = new Set<string>();
  for (const [type, rows] of Object.entries(answered.records ?? {})) {
    types.add(type);
    for (const key of Object.keys(rows)) seen.set(recordKey(type, key), store.synced(type, key));
  }
  for (const [type, keys] of Object.entries(answered.removed ?? {})) {
    types.add(type);
    for (const key of keys) seen.set(recordKey(type, key), store.synced(type, key));
  }
  return store.afterWrites(types, () => land(unmovedOnly(store, answered, seen)), echoed);
}

/** Built with `fromEntries`, never by assignment: a record type and a column are the server's data. */
function unmovedOnly(
  store: RecordStore,
  answered: CatchUpRecords,
  seen: ReadonlyMap<string, Row | undefined>,
): CatchUpRecords {
  const records = Object.fromEntries(
    Object.entries(answered.records ?? {}).map(([type, rows]) => [
      type,
      Object.fromEntries(
        Object.entries(rows).flatMap(([key, row]) => {
          const kept = unmovedColumns(seen.get(recordKey(type, key)), store.synced(type, key), row);
          return kept === undefined ? [] : [[key, kept]];
        }),
      ),
    ]),
  );
  const removed = Object.fromEntries(
    Object.entries(answered.removed ?? {}).map(([type, keys]) => [
      type,
      keys.filter((key) => seen.get(recordKey(type, key)) === store.synced(type, key)),
    ]),
  );
  return { ...answered, records, removed };
}

/** The read's row without the columns that moved between `before` and `now`; none if it is gone. */
function unmovedColumns(before: Row | undefined, now: Row | undefined, read: Row): Row | undefined {
  if (before === now) return read;
  if (now === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(read).filter(([column]) => before?.[column] === now[column]),
  );
}
