// Single responsibility: who a history row names. The history trigger reads `x.actor` and
// `x.request` from the WRITE'S transaction; this sets them, once per transaction, before the first
// repository write to an entity that keeps history. No transaction, nothing set: the trigger then
// records `null`, never a guess.

import { tryUseContext } from '@ultimat3/core';
import { ACTOR_SETTING, currentTx, type DbTx, REQUEST_SETTING, setLocal } from '@ultimat3/db';

const stamped = new WeakSet<DbTx>();

/** Before a write to `entity` on the ambient connection. A pinned repository is never stamped. */
export async function stampHistoryActor(
  entity: { readonly $history: unknown },
  pinned: boolean,
): Promise<void> {
  if (entity.$history === null || pinned) return;
  const tx = currentTx();
  const ctx = tryUseContext();
  if (tx === undefined || ctx === undefined || stamped.has(tx)) return;
  await setLocal(tx, { [ACTOR_SETTING]: ctx.actor.id, [REQUEST_SETTING]: ctx.requestId });
  stamped.add(tx);
}
