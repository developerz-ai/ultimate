// One test file loaded AGAIN in the same process — `bun test --rerun-each`, CI's `flaky` job —
// re-evaluates its own module body and nothing it imports. What that BODY declared last run is
// forgotten as the file reloads, so `entity()` / `job()` at module scope declare afresh instead of
// throwing X_ENTITY_DUPLICATE / X_JOB_DUPLICATE. `registry-leak-guard.ts` owns WHEN.

import type { RegistryEntry } from '@ultimat3/entity';
import type { AnyJobHandle } from '@ultimat3/jobs';
import { registeredJobs, restoreJobs } from '@ultimat3/jobs';
import { loaded } from './per-test-reset';

/** A name-keyed process registry this module can read, prune and refill. */
export interface DeclarationRegistry {
  readonly kind: string;
  names(): readonly string[];
  /** Removes `names`; answers what it removed, to hand back to `putBack`. */
  forget(names: ReadonlySet<string>): readonly unknown[];
  /** Re-registers each entry whose name is absent now; one the body declared again stays. */
  putBack(entries: readonly unknown[]): void;
}

export interface RerunDeclarations {
  /** The file at `path` is about to evaluate: forget what its body declared on its last run. */
  loading(path: string): void;
  /** Its imports have evaluated and its body is about to: the baseline its body adds to. */
  bodyStart(): void;
  /** Its body has evaluated: record what it declared; refill what this run did not redo. */
  bodyEnd(): void;
}

/**
 * Only the BODY's window — after its imports, before its first hook — and never what a test or
 * hook registers: that is the file's own to undo, and a test's import inside a body would then be
 * forgotten for a module that will not evaluate again. A name forgotten and not declared again
 * (a top-level `await import()` that was a cache hit this time) is put back at `bodyEnd`.
 */
export function rerunDeclarations(
  registries: () => readonly DeclarationRegistry[],
): RerunDeclarations {
  const declaredBy = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  let current: string | undefined;
  let baseline = new Map<string, ReadonlySet<string>>();
  let forgotten = new Map<string, readonly unknown[]>();
  return {
    loading(path) {
      current = path;
      forgotten = new Map();
      const last = declaredBy.get(path);
      if (last === undefined) return;
      for (const registry of registries()) {
        const names = last.get(registry.kind);
        if (names !== undefined && names.size > 0) {
          forgotten.set(registry.kind, registry.forget(names));
        }
      }
    },
    bodyStart() {
      baseline = new Map(
        registries().map((registry) => [registry.kind, new Set(registry.names())]),
      );
    },
    bodyEnd() {
      if (current === undefined) return;
      const declared = new Map<string, ReadonlySet<string>>();
      for (const registry of registries()) {
        const before = baseline.get(registry.kind) ?? new Set<string>();
        declared.set(registry.kind, new Set(registry.names().filter((name) => !before.has(name))));
        const stash = forgotten.get(registry.kind);
        if (stash !== undefined) registry.putBack(stash);
      }
      declaredBy.set(current, declared);
      current = undefined;
      forgotten = new Map();
    },
  };
}

/** Jobs: `@ultimat3/jobs` is already in every test's graph (`registry-snapshot.ts` imports it). */
const jobRegistry: DeclarationRegistry = {
  kind: 'job',
  names: () => registeredJobs().map((handle) => handle.name),
  forget(names) {
    const all = registeredJobs();
    restoreJobs(all.filter((handle) => !names.has(handle.name)));
    return all.filter((handle) => names.has(handle.name));
  },
  putBack(entries) {
    const live = registeredJobs();
    const present = new Set(live.map((handle) => handle.name));
    const missing = (entries as readonly AnyJobHandle[]).filter((h) => !present.has(h.name));
    if (missing.length > 0) restoreJobs([...live, ...missing]);
  },
};

interface EntityRegistryModule {
  readonly registeredEntities: () => readonly RegistryEntry[];
  readonly registerEntity: (entry: RegistryEntry) => RegistryEntry;
  readonly getEntity: (name: string) => RegistryEntry | undefined;
  readonly clearRegistry: () => void;
}

/**
 * Entities, only once something in this process loaded `@ultimat3/entity`: importing it here would
 * put the entity registry into every `packages/core` test (`registry-isolation.ts`'s reason).
 */
const entityRegistry = (module: EntityRegistryModule): DeclarationRegistry => ({
  kind: 'entity',
  names: () => module.registeredEntities().map((entry) => entry.name),
  forget(names) {
    const all = module.registeredEntities();
    module.clearRegistry();
    for (const entry of all) if (!names.has(entry.name)) module.registerEntity(entry);
    return all.filter((entry) => names.has(entry.name));
  },
  putBack(entries) {
    for (const entry of entries as readonly RegistryEntry[]) {
      if (module.getEntity(entry.name) === undefined) module.registerEntity(entry);
    }
  },
});

/** The registries a framework test file declares into at module scope, as loaded right now. */
export function frameworkDeclarationRegistries(): readonly DeclarationRegistry[] {
  const path = loaded('@ultimat3/entity', 'registry.ts');
  if (path === undefined) return [jobRegistry];
  // why: synchronous, as the body hooks are; the module is in the cache, so this evaluates nothing.
  return [jobRegistry, entityRegistry(require(path) as EntityRegistryModule)];
}
