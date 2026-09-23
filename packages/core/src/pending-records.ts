/**
 * Records answered before the page's store exists. The store is installed by the first realtime
 * hook, and an action or query can answer earlier than that — so in a BROWSER page the handle
 * holds the latest row per `type:key` (and the keys removed since) here, and hands them to the
 * store once, when it is installed. Bounded by the keys themselves: a row seen twice is one entry.
 */

import type { Row } from './conflict-policy';
import type { RecordRows } from './record-envelope';
import type { RecordSink } from './record-sink';

export interface PendingRecords extends RecordSink {
  /** Adopts everything held into `sink`, then forgets it — a second drain adopts nothing. */
  drainInto(sink: RecordSink): void;
  /** Forgets everything held: the principal changed, and these rows were the previous one's. */
  clear(): void;
}

export function pendingRecords(): PendingRecords {
  const rows = new Map<string, Map<string, Row>>();
  const removed = new Map<string, Set<string>>();
  const group = <T>(table: Map<string, T>, type: string, make: () => T): T => {
    const found = table.get(type);
    if (found !== undefined) return found;
    const created = make();
    table.set(type, created);
    return created;
  };
  return {
    adopt(type: string, incoming: RecordRows): void {
      const held = group(rows, type, () => new Map<string, Row>());
      for (const [key, row] of Object.entries(incoming)) {
        held.set(key, row);
        removed.get(type)?.delete(key);
      }
    },
    remove(type: string, keys: readonly string[]): void {
      const gone = group(removed, type, () => new Set<string>());
      for (const key of keys) {
        rows.get(type)?.delete(key);
        gone.add(key);
      }
    },
    drainInto(sink: RecordSink): void {
      for (const [type, held] of rows) {
        if (held.size > 0) sink.adopt(type, Object.fromEntries(held));
      }
      for (const [type, gone] of removed) {
        if (gone.size > 0) sink.remove(type, [...gone]);
      }
      this.clear();
    },
    clear(): void {
      rows.clear();
      removed.clear();
    },
  };
}
