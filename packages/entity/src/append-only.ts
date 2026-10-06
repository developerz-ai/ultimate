// `entity({ appendOnly: true })`: what the declaration may not hold, and the repository seam that
// refuses every write changing or removing a stored row. Applied by BOTH drivers, beside
// `sealedRepo`, so `database()`, a seed and anything else holding `driver.repo(entity)` are refused
// alike — and before any statement exists, so memory and Postgres answer the same code.

import { appendOnlyColumnRefused, appendOnlyRefused } from './append-only-errors';
import type { Repo, UpsertArgs } from './repo';
import type { AnyColumn } from './types';

/** The two members the seam reads — so a driver written outside this package can pass its entity. */
export interface AppendOnlySource {
  readonly $name: string;
  readonly $appendOnly: boolean;
}

/**
 * Refused at declaration: each is a column whose whole meaning is an UPDATE. A soft delete IS one
 * (`deleted_at = now()`), an `onUpdateNow()` stamp is written by one, and a state machine moves by
 * one — on an append-only table all three would be declared and never able to happen.
 */
export const assertAppendOnlyColumns = (
  entityName: string,
  entries: readonly (readonly [string, AnyColumn])[],
  softDeleteColumn: string,
): void => {
  for (const [property, column] of entries) {
    const meta = column.$meta;
    if (property === softDeleteColumn) {
      throw appendOnlyColumnRefused(
        entityName,
        property,
        'makes the entity soft-deletable, and a soft delete is an UPDATE',
      );
    }
    if (meta.onUpdate !== undefined) {
      throw appendOnlyColumnRefused(entityName, property, 'is onUpdateNow(), stamped by an UPDATE');
    }
    if (meta.machine !== undefined) {
      throw appendOnlyColumnRefused(
        entityName,
        property,
        'declares .transitions(), and a transition is an UPDATE',
      );
    }
  }
};

/**
 * `repo`, refusing. Inserts and reads pass through untouched; the five calls that rewrite or remove
 * a row reject — `upsertAll` unless `onMatch: 'nothing'`, which only ever appends. Every refusal is
 * `async`, so it rejects rather than throws, as the contract requires; a spread over the inner
 * repository keeps a member this file does not know (`MemoryRepo.reset()`).
 *
 * A backfill is refused too, deliberately: there is no bypass, because a ledger an author's job can
 * rewrite is not append-only. Changing existing rows is lifting the flag, in a migration.
 */
export const appendOnlyRepo = <Row, R extends Repo<Row>>(entity: AppendOnlySource, repo: R): R => {
  if (!entity.$appendOnly) return repo;
  const name = entity.$name;
  const refusing: Pick<
    Repo<Row>,
    'update' | 'delete' | 'updateWhere' | 'deleteWhere' | 'upsertAll'
  > = {
    update: async () => {
      throw appendOnlyRefused(name, 'update');
    },
    delete: async () => {
      throw appendOnlyRefused(name, 'delete');
    },
    updateWhere: async () => {
      throw appendOnlyRefused(name, 'updateWhere');
    },
    deleteWhere: async () => {
      throw appendOnlyRefused(name, 'deleteWhere');
    },
    async upsertAll(rows, args: UpsertArgs<Row>) {
      if (args.onMatch !== 'nothing') throw appendOnlyRefused(name, 'upsertAll');
      return repo.upsertAll(rows, args);
    },
  };
  return { ...repo, ...refusing };
};
