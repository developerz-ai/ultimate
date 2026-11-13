// One test file loaded AGAIN in the same process — `bun test --rerun-each`, CI's `flaky` job —
// re-evaluates its own module body and nothing it imports. What that FILE declared last run — its
// body, its hooks, its tests — is forgotten as it reloads, so it declares afresh instead of throwing
// X_*_DUPLICATE. `registry-leak-guard.ts` owns WHEN; `rerun-registries.ts` lists the registries.

import type { ModuleLedger } from './rerun-modules';
import { processModules } from './rerun-modules';

/** A name-keyed process registry this module can read, prune and refill. */
export interface DeclarationRegistry {
  readonly kind: string;
  names(): readonly string[];
  /** Removes `names`; answers what it removed, to hand back to `putBack`. */
  forget(names: ReadonlySet<string>): readonly unknown[];
  /** Re-registers each entry whose name is absent now; one the file declared again stays. */
  putBack(entries: readonly unknown[]): void;
  /** Whether one of `values` — a module's exports — is what `name` registered. */
  exported(name: string, values: readonly unknown[]): boolean;
}

export interface RerunDeclarations {
  /** The file at `path` is about to evaluate: forget what it declared on its last run. */
  loading(path: string): void;
  /** Its imports have evaluated and its body is about to: the baseline its body adds to. */
  bodyStart(): void;
  /** Its body has evaluated: record what it declared; refill what this run did not redo. */
  bodyEnd(): void;
  /** The file is over: refill what its hooks and tests did not redo, and remember the rest. */
  fileEnd(): void;
}

type KindNames = ReadonlyMap<string, ReadonlySet<string>>;

interface Mark {
  readonly names: KindNames;
  /** The modules evaluated when its body ended. */
  readonly modules: ReadonlySet<string>;
}

const sample = (registries: readonly DeclarationRegistry[]): KindNames =>
  new Map(registries.map((registry) => [registry.kind, new Set(registry.names())]));

const forgetAll = (
  registries: readonly DeclarationRegistry[],
  last: KindNames | undefined,
): Map<string, readonly unknown[]> => {
  const stash = new Map<string, readonly unknown[]>();
  if (last === undefined) return stash;
  for (const registry of registries) {
    const names = last.get(registry.kind);
    if (names !== undefined && names.size > 0) stash.set(registry.kind, registry.forget(names));
  }
  return stash;
};

const union = (a: KindNames, b: KindNames | undefined): KindNames => {
  if (b === undefined) return a;
  const merged = new Map<string, ReadonlySet<string>>(b);
  for (const [kind, names] of a) merged.set(kind, new Set([...(b.get(kind) ?? []), ...names]));
  return merged;
};

const putBackAll = (
  registries: readonly DeclarationRegistry[],
  stash: ReadonlyMap<string, readonly unknown[]>,
): void => {
  for (const registry of registries) {
    const entries = stash.get(registry.kind);
    if (entries !== undefined) registry.putBack(entries);
  }
};

/**
 * Two windows, two rules. The BODY — after its imports, before its first hook — is the file's own
 * by construction. AFTER it, a hook or a test can also `await import()` a module that declares,
 * and a module evaluates once per process: forgetting its names would leave the rerun without
 * them. So a name added after the body is the file's unless a module first evaluated since then
 * EXPORTS what it registered (`sendMailJob`, `baseLayout`). One such module that declares without
 * exporting is the case this cannot see: its rerun goes without that name, and says so by failing.
 * A forgotten name the rerun does not declare again goes back: the body's at `bodyEnd`, the rest
 * at `fileEnd`. Nothing runs per test: one read at the body's end, one at the file's.
 */
export function rerunDeclarations(
  registries: () => readonly DeclarationRegistry[],
  modules: ModuleLedger = processModules,
): RerunDeclarations {
  const declaredBy = new Map<string, { readonly body: KindNames; readonly later: KindNames }>();
  let current: string | undefined;
  let baseline: KindNames = new Map();
  let body: KindNames | undefined;
  let mark: Mark | undefined;
  let forgottenBody = new Map<string, readonly unknown[]>();
  let forgottenLater = new Map<string, readonly unknown[]>();
  /** What the file added after its body: not what a module it evaluated meanwhile exports. */
  const addedSinceBody = (live: readonly DeclarationRegistry[]): KindNames => {
    const added = new Map<string, ReadonlySet<string>>();
    if (mark === undefined || current === undefined) return added;
    let exports: readonly unknown[] | undefined;
    for (const registry of live) {
      const before = mark.names.get(registry.kind) ?? new Set<string>();
      const gained = registry.names().filter((name) => !before.has(name));
      if (gained.length === 0) continue;
      // Read once, and only when something was gained: ~1 ms over a large module cache.
      exports ??= modules.exportsSince(mark.modules, current);
      const own = exports;
      added.set(registry.kind, new Set(gained.filter((name) => !registry.exported(name, own))));
    }
    return added;
  };
  const fileEnd = (): void => {
    if (current === undefined) return;
    const live = registries();
    const last = declaredBy.get(current);
    const later = addedSinceBody(live);
    // A body that threw never reached `bodyEnd`: what was forgotten for it goes back here, and its
    // last complete record stands in for the names it did not get to report.
    putBackAll(live, forgottenBody);
    putBackAll(live, forgottenLater);
    declaredBy.set(current, {
      body: body ?? last?.body ?? new Map(),
      // Kept from the last run too: a test this run skipped (`-t`) declares again on the next.
      later: union(later, last?.later),
    });
    current = undefined;
    body = undefined;
    mark = undefined;
    forgottenBody = new Map();
    forgottenLater = new Map();
  };
  return {
    loading(path) {
      fileEnd();
      current = path;
      const last = declaredBy.get(path);
      forgottenBody = forgetAll(registries(), last?.body);
      forgottenLater = forgetAll(registries(), last?.later);
    },
    bodyStart() {
      baseline = sample(registries());
    },
    bodyEnd() {
      if (current === undefined) return;
      const live = registries();
      const now = sample(live);
      const declared = new Map<string, ReadonlySet<string>>();
      for (const [kind, names] of now) {
        const before = baseline.get(kind) ?? new Set<string>();
        declared.set(kind, new Set([...names].filter((name) => !before.has(name))));
      }
      body = declared;
      putBackAll(live, forgottenBody);
      forgottenBody = new Map();
      mark = { names: sample(live), modules: modules.snapshot() };
    },
    fileEnd,
  };
}
