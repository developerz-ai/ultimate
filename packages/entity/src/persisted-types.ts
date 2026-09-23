// The record types the client keeps on disk — every registered entity declared `persist: true`,
// by name, sorted. What the server renders as `<meta name="ultimate-persist">`, since the browser
// holds no entity declarations. Memoised against the registry's generation, like `record-table.ts`.

import { registeredEntities, registryGeneration } from './registry';

let cached: { readonly generation: number; readonly types: readonly string[] } | null = null;

/** Sorted, so the rendered meta is byte-identical for one set of declarations. */
export const persistedRecordTypes = (): readonly string[] => {
  const generation = registryGeneration();
  if (cached !== null && cached.generation === generation) return cached.types;
  const types = Object.freeze(
    registeredEntities()
      .filter((entry) => entry.persist === true)
      .map((entry) => entry.name)
      .sort(),
  );
  cached = { generation, types };
  return types;
};
