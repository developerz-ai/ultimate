// The one seam a factory's `create()` writes through, and its default: the entity's own repository
// on the process driver, the one `database()` reads through. Structural over `EntityLike` so the
// barrel stays entity-free — `@ultimat3/entity` loads on the first write, never on import.

import type { DbClient } from '@ultimat3/db';
import type { Driver, EntityCore, Repo } from '@ultimat3/entity';
import { FactoryNotPersistedError } from './errors';
import type { EntityLike } from './factory-types';

/**
 * Writes one built row and answers the row AS STORED — declared defaults, generated columns and
 * timestamps included. `create()` returns exactly this, so a test asserts on what the table holds,
 * never on what the factory meant to write.
 */
export interface Persister {
  insert(entity: EntityLike, row: object): Promise<object>;
}

let current: Persister | undefined;

/**
 * Replace the default writer, once, in the test preload: `usePersister(entityPersister({ driver }))`
 * for an app that names its own driver. Process-global for the reason the fixture registry is: a
 * factory is imported by the file under test, not handed to it.
 */
export function usePersister(persister: Persister): void {
  current = persister;
}

/** Hand the process back to the default. An `afterAll` in any file that installed one of its own. */
export function clearPersister(): void {
  current = undefined;
}

export const persisterInstalled = (): boolean => current !== undefined;

/** Install for one run and hand back what was there: the factory lint's own throwaway writer. */
export function swapPersister(next: Persister | undefined): Persister | undefined {
  const previous = current;
  current = next;
  return previous;
}

/** Where `entityPersister` writes. One or the other: two answers to one question is a compile error. */
export type PersisterTarget =
  /** Postgres (or PGlite) through this client: `postgresRepo(entity, { client })`. */
  | { readonly client: DbClient; readonly driver?: never }
  /** This driver's repositories. Left out: `defaultDriver()`, the one `database()` names by default. */
  | { readonly driver?: Driver; readonly client?: never };

/** A real `entity()` value: the only kind a repository can be built over. */
export const isEntity = (entity: EntityLike): entity is EntityLike & EntityCore =>
  typeof entity.$parse === 'function' &&
  '$describe' in entity &&
  typeof entity.$describe === 'function' &&
  '$name' in entity;

/** The tenant a write runs under: the row's own tenant column, as a script has no actor. */
export const tenantScope = (entity: EntityLike, row: object): { orgId?: string } => {
  const column = entity.$tenantColumn ?? null;
  const value = column === null ? undefined : (row as Readonly<Record<string, unknown>>)[column];
  return typeof value === 'string' ? { orgId: value } : {};
};

/**
 * Through the entity's own repository: `$parse` fills declared defaults and validates every
 * column, the repository runs the invariants and answers the stored row (`returning *` on Postgres).
 */
export function entityPersister(target: PersisterTarget = {}): Persister {
  let make: Promise<(entity: EntityCore) => Repo<unknown>> | undefined;
  const resolve = async (): Promise<(entity: EntityCore) => Repo<unknown>> => {
    const { defaultDriver, postgresRepo } = await import('@ultimat3/entity');
    const { client } = target;
    if (client !== undefined) return (entity) => postgresRepo(entity, { client });
    const driver = target.driver ?? defaultDriver();
    return (entity) => driver.repo(entity);
  };
  return {
    async insert(entity, row) {
      if (!isEntity(entity)) throw new FactoryNotPersistedError({ table: entity.$table });
      make ??= resolve();
      const repo = (await make)(entity);
      // `$parse` answers the entity's row type, which a `Repo<unknown>` spells as `RowWrite<unknown>`.
      const parsed = entity.$parse(row) as Parameters<Repo<unknown>['insert']>[0];
      const stored = await repo.insert(parsed, tenantScope(entity, row));
      return stored as object;
    },
  };
}

const fallback = entityPersister();

/**
 * The installed persister, else the entity repository on the process driver. A lookalike with no
 * `$parse` has no repository, so with nothing installed it is `X_TEST_FACTORY_NOT_PERSISTED`.
 */
export async function persistRow(entity: EntityLike, row: object): Promise<object> {
  return (current ?? fallback).insert(entity, row);
}
