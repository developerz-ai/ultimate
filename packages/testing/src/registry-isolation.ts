// One test seam: an empty entity registry for the test that needs one, and the process's own
// registry back afterwards. `entity()` registers at MODULE scope — which is idiomatic, an app
// declares its domain by importing it — so a test asserting on the WHOLE registry inherits every
// entity any earlier file in the same `bun test` process imported, and its premise becomes
// whatever ran before it rather than what it declared.

import { clearRegistry, registerEntity, registeredEntities } from '@ultimat3/entity';

/**
 * Empties the entity registry and returns the function that puts it back, entry for entry.
 * For a test whose subject is "no entities are declared" — `x db gen` with nothing to generate,
 * a manifest with no rows — which is otherwise true only until a neighbouring file imports one:
 *
 *   const restoreEntities = isolateEntityRegistry();
 *   try {
 *     // …the assertion that needs an empty registry
 *   } finally {
 *     restoreEntities();
 *   }
 *
 * Restoring rather than leaving it empty is the half that matters: `entity()` runs once per
 * module, so a registry cleared and not refilled cannot be repopulated by a later import.
 */
export function isolateEntityRegistry(): () => void {
  const captured = registeredEntities();
  clearRegistry();
  return () => {
    clearRegistry();
    for (const entry of captured) registerEntity(entry);
  };
}
