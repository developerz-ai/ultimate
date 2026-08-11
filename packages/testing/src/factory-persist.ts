// The one seam a factory's `create()` writes through. Structural rather than an import of
// `@ultimat3/entity`'s `Repo`: testing must not take a package dependency for one type — the same
// reason `LiveTarget` is declared structurally in fixture-drivers.ts.

import { FactoryNotPersistedError } from './errors';

/**
 * Writes a built row and answers nothing. Returning the stored row would make `create()` and
 * `build()` able to disagree about what the row is, and a test could then only find out which one
 * it holds by looking — the ambiguity axiom 1 forbids. The factory owns every column; the
 * persister owns only whether the row exists.
 */
export interface Persister {
  insert<TRow extends object>(table: string, row: TRow): Promise<void>;
}

let current: Persister | undefined;

/**
 * Install the writer, once, in the test preload. Process-global for the same reason the fixture
 * registry is: a factory is imported by the file under test, not handed to it.
 */
export function usePersister(persister: Persister): void {
  current = persister;
}

/** Hand the process back. An `afterAll` in any file that installed one of its own. */
export function clearPersister(): void {
  current = undefined;
}

export const persisterInstalled = (): boolean => current !== undefined;

/**
 * Throws where the row would have been written, so the failure names the table it was for rather
 * than surfacing as a missing method on `undefined` inside the factory.
 */
export async function persistRow<TRow extends object>(table: string, row: TRow): Promise<void> {
  if (current === undefined) throw new FactoryNotPersistedError({ table });
  await current.insert(table, row);
}
