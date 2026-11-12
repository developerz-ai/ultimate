// Single responsibility: the `create extension` an index needs before it can be built — today one,
// `pg_trgm` for `gin_trgm_ops` — emitted by `x db gen` once, in the migration that first builds
// such an index. Never dropped in `down`: another index, or the app's own SQL, may use it.

import type { EntityDescriptionLike } from './entity-shape';
import { requiredExtension } from './index-key-ddl';
import { findTable, type SchemaDescription } from './introspect';
import { declaredIndexes } from './invariant-ddl';
import { identifier } from './sql';

/**
 * `create extension if not exists …` for each extension a declared index needs whose recorded
 * counterpart did not already need it — so the migration that adds the first trigram index carries
 * it, and the next `x db gen` (the index recorded) carries nothing. Sorted, one per extension.
 */
export function extensionStatements(
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): readonly string[] {
  const needed = new Set<string>();
  for (const entity of entities) {
    const recorded = findTable(current, entity.table)?.indexes ?? [];
    for (const index of declaredIndexes(entity)) {
      const extension = requiredExtension(index);
      if (extension === null) continue;
      const before = recorded.find((each) => each.name === index.name);
      if (before !== undefined && requiredExtension(before) === extension) continue;
      needed.add(extension);
    }
  }
  return [...needed]
    .sort()
    .map((extension) => `create extension if not exists ${identifier(extension).text};`);
}
