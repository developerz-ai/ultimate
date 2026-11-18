// Single responsibility: an `entity()` a test declares ends with that test. The registry is one
// process-wide map, so a declaration left behind reaches the file's other tests in whatever order
// they run. A test double, not public API: not exported from `index.ts`, excluded from the package.

import { afterEach, beforeEach } from 'bun:test';
import type { RegistryEntry } from './registry';
import { clearRegistry, registerEntity, registeredEntities } from './registry';

/** Called at file scope: every test finds the registry the file's own module scope declared. */
export function restoreRegistryAfterEachTest(): void {
  let found: readonly RegistryEntry[] = [];
  beforeEach(() => {
    found = registeredEntities();
  });
  afterEach(() => {
    clearRegistry();
    for (const entry of found) registerEntity(entry);
  });
}
