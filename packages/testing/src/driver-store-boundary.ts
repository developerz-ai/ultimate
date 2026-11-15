// The driver kinds `@ultimat3/entity` has noted (`driverStores()`), put back at the file boundary
// to what the file inherited. `x verify`'s drift step reads that record to tell a Postgres app from
// a `defineDriver` one, so a file that built a custom driver turned every later file's drift step
// on a shared worker into "a store that owns its own schema" and skipped its rails. Read through
// the `require` cache, never imported: `@ultimat3/entity` stays out of every `packages/core` graph.

import type { clearDriverStores, driverStores, noteDriverStore } from '@ultimat3/entity/adapter';
import { loaded } from './per-test-reset';

interface DriverRegistry {
  readonly driverStores: typeof driverStores;
  readonly clearDriverStores: typeof clearDriverStores;
  readonly noteDriverStore: typeof noteDriverStore;
}

type Noted = ReturnType<typeof driverStores>;

const EMPTY: Noted = { sql: [], custom: [] };

/** The registry module when something in this process loaded it, else `undefined`. */
const registry = (): DriverRegistry | undefined => {
  const path = loaded('@ultimat3/entity', 'driver-registry.ts');
  return path === undefined ? undefined : (require(path) as DriverRegistry);
};

/** What is noted now; nothing when the package was never loaded. */
export function captureDriverStores(): Noted {
  return registry()?.driverStores() ?? EMPTY;
}

/** Exactly `noted` again — a REPLACE, as the permission set is. A no-op while entity is unloaded. */
export function restoreDriverStores(noted: Noted): void {
  const live = registry();
  if (live === undefined) return;
  live.clearDriverStores();
  for (const name of noted.sql) live.noteDriverStore('sql', name);
  for (const name of noted.custom) live.noteDriverStore('custom', name);
}
