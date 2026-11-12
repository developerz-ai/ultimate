// What the many-row write checks share: the row observer heard through its two bus events, counted
// as one figure — so a write path that reports its rows as `entity.row`, as `entity.bulk` or as a
// mix is held to the one claim that matters, that none of them went unreported.

import type { EntityBulkEvent, EntityRowEvent } from '@ultimat3/core';
import { subscribe } from '@ultimat3/core';

export interface Heard {
  readonly rows: readonly EntityRowEvent[];
  readonly bulk: readonly EntityBulkEvent[];
}

/**
 * `work`'s answer and every change the observer reported for `entity` while it ran. The two
 * subscriptions are this call's own and are removed whatever `work` does — never a reset of the
 * process-wide bus, which another suite in the process may be listening on.
 */
export const heard = async <T>(
  entity: string,
  work: () => Promise<T>,
): Promise<{ readonly answer: T; readonly heard: Heard }> => {
  const rows: EntityRowEvent[] = [];
  const bulk: EntityBulkEvent[] = [];
  const offRow = subscribe('entity.row', (event) => {
    if (event.payload.entity === entity) rows.push(event.payload);
  });
  const offBulk = subscribe('entity.bulk', (event) => {
    if (event.payload.entity === entity) bulk.push(event.payload);
  });
  try {
    return { answer: await work(), heard: { rows, bulk } };
  } finally {
    offRow();
    offBulk();
  }
};

/** How many written rows the observer accounted for: one per row event, `rows` per bulk event. */
export const accountedFor = ({ rows, bulk }: Heard): number =>
  rows.length + bulk.reduce((sum, event) => sum + event.rows, 0);
