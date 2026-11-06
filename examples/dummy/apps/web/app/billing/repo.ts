/** Every SQL statement the billing feature runs. No rules, no formatting, no HTTP. */

import { db, type PlanRow } from '@postly/db';

/**
 * The catalog rows, keyed on `(code, currency)` — the plan's own primary key, so a price the vendor
 * publishes twice lands on one row. `plans` belongs to no tenant, so the collision cannot cross one.
 */
export const upsertPlans = async (rows: readonly PlanRow[]): Promise<void> => {
  if (rows.length === 0) return;
  await db.plans.upsertAll(
    rows.map(({ code, currency, monthly, seats }) => ({ code, currency, monthly, seats })),
    { onConflict: ['code', 'currency'] },
  );
};

/** Where `stream` stopped; `null` before its first committed batch. */
export const cursorOf = async (stream: string): Promise<number | null> =>
  (await db.streamCursors.where({ stream }).one())?.position ?? null;

/** Called by `consumer()` inside the batch's transaction — never on its own. */
export const saveCursor = async (stream: string, position: number): Promise<void> => {
  await db.streamCursors.upsertAll([{ stream, position }], { onConflict: ['stream'] });
};
