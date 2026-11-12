// Single responsibility: the in-process twin of Postgres' `x.purge`. A history table refuses every
// delete (append-only, both drivers); inside `purgingHistory(name, work)` a filtered delete of THAT
// history table only is let through — the erase a subject's GDPR job owes. Postgres still has its
// guard trigger, which reads `x.purge`; the memory driver has no trigger, so this is its guard.

import { asyncContext } from '@ultimat3/core';

const purge = asyncContext<string>('the history table a purge may delete from');

/** Run `work` with `historyEntity`'s rows deletable — by `deleteWhere` and a chain's `deleteAll`. */
export const purgingHistory = <R>(historyEntity: string, work: () => Promise<R>): Promise<R> =>
  purge.run(historyEntity, work);

/** Whether a purge scope names `entityName` right now. */
export const purgeNames = (entityName: string): boolean => purge.get() === entityName;
