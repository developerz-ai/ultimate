// The tables the many-row write checks share (chain writes, `updateMany`, the unreturned and COPY
// writes): one per concern — plain, tenant-scoped, soft-deleting under a JS-only rule, append-only,
// sealed, history-keeping. Each check re-creates the tables it names, so sharing them is free.

import { expect } from 'bun:test';
import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';

export const notes = remember(
  entity('ec_wr_notes', {
    columns: {
      id: uuid().primaryKey(),
      kind: text({ max: 20 }),
      title: text({ max: 40 }),
      body: text({ max: 40 }).nullable(),
      updatedAt: timestamp().defaultNow().onUpdateNow(),
    },
  }),
);

export const posts = remember(
  entity('ec_wr_posts', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 40 }) },
  }),
);

const stampHasReason = (deletedAt: unknown, reason: unknown): boolean =>
  deletedAt === null || reason !== null;

/** Soft-deleting, with a rule no CHECK can state: a stamp needs a reason. */
export const swept = remember(
  entity('ec_wr_swept', {
    columns: {
      id: uuid().primaryKey(),
      kind: text({ max: 20 }),
      reason: text({ max: 40 }).nullable(),
      deletedAt: timestamp().nullable(),
    },
    invariants: (c) => [
      invariant('ec_wr_stamp_has_reason', c.satisfies(stampHasReason, ['deletedAt', 'reason'])),
    ],
  }),
);

export const ledger = remember(
  entity('ec_wr_ledger', {
    columns: { id: uuid().primaryKey(), account: text({ max: 20 }), note: text({ max: 20 }) },
    appendOnly: true,
  }),
);

export const vault = remember(
  entity('ec_wr_vault', {
    columns: {
      id: uuid().primaryKey(),
      label: text({ max: 20 }),
      secret: text({ max: 40 }).nullable().sealed(),
      email: text().sealed({ lookup: true }),
    },
  }),
);

export const logged = remember(
  entity('ec_wr_logged', {
    columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text({ max: 40 }) },
    history: true,
  }),
);
export const loggedHistory = remember(
  logged.$history ?? expect.unreachable('history: true declares a history entity'),
);
