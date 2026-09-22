// Which record type a live query's rows are, and the key each row travels under. A changefeed and
// a snapshot speak TABLES; the page store keys records by the entity's NAME and PRIMARY KEY. Both
// come from the entity's own projection here, on the server — the browser never derives a key.

import type { Row } from '@ultimat3/core/page';
import { recordProjectionForTable } from '@ultimat3/entity/record';

export interface LiveRecords {
  /** The entity name — or the table itself when no registered entity owns it. */
  readonly type: string;
  /** The row's record key, or `null` for a plain table, whose rows are keyed by `id`. */
  readonly key: ((row: Row) => string) | null;
}

export function liveRecords(table: string): LiveRecords {
  const projection = recordProjectionForTable(table);
  if (projection === undefined) return { type: table, key: null };
  return { type: projection.type, key: (row) => projection.key(row) };
}
