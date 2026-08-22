// Hands a module of primitives to the package that owns them, without a sideways import:
// `defineApi` in `@ultimat3/action` cannot import `@ultimat3/query`'s `registerQueries` on
// the same tier, so each owner announces its registrar here at import time and callers ask
// by kind. Same shape as `defineService` and `registerErrorCodes`.

import { UltimateError } from './errors';

/**
 * The eight primitives — the framework's whole vocabulary. A registrar exists only for the
 * kinds registered by module.
 *
 * The runtime list is the source and the type derives from it, so the two cannot drift apart.
 * A ninth entry is a design error, not a feature: a new capability arrives as a FACTORY over an
 * existing primitive — `llm()` returns an `action` — never as a new kind of thing. That rule is
 * only real if something fails when it is broken, so `registrar.test.ts` pins this set.
 */
export const PRIMITIVE_KINDS = [
  'action',
  'entity',
  'job',
  'mutator',
  'policy',
  'query',
  'route',
  'task',
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/** One factory over one primitive: the export's name, the package that ships it, what it returns. */
export interface PrimitiveFactory {
  readonly factory: string;
  /** The package specifier the factory is imported from, so a `fix:` can be pasted. */
  readonly pkg: string;
  readonly kind: PrimitiveKind;
}

/**
 * The other half of "never invent a ninth": the factories that already exist, in one table.
 *
 * Prose counted them — "the fourth instance of the framework's factory rule" — in three files that
 * cannot see each other, so every ordinal was wrong the moment a fifth landed and none of them
 * could be checked. A list here can be: `@ultimat3/cli` is tier 5, may import `ai`, `jobs` and
 * `scraping`, and pins that every exported function returning an `Action`/`JobHandle` from outside
 * their owning packages has a row. Adding a factory means adding a row, not editing a sentence.
 *
 * Sorted by package then name so the diff of a new row is one line.
 */
export const PRIMITIVE_FACTORIES = Object.freeze<readonly PrimitiveFactory[]>([
  { factory: 'agent', pkg: '@ultimat3/ai', kind: 'action' },
  { factory: 'agentJob', pkg: '@ultimat3/ai', kind: 'job' },
  { factory: 'hive', pkg: '@ultimat3/ai', kind: 'action' },
  { factory: 'llm', pkg: '@ultimat3/ai', kind: 'action' },
  { factory: 'backfill', pkg: '@ultimat3/jobs', kind: 'job' },
  { factory: 'scrape', pkg: '@ultimat3/scraping', kind: 'job' },
]);

/**
 * What a registrar hands back: the primitives it actually took, each carrying the name
 * registration stamped on it. Returning the registered set — rather than nothing — is what lets
 * a caller build its API map from what registered instead of from what a module exported.
 */
export interface RegisteredPrimitive {
  readonly kind: PrimitiveKind;
  readonly name: string;
}

/** `registerActions` / `registerQueries`: export names become primitive names. */
export type ModuleRegistrar = (
  module: Readonly<Record<string, unknown>>,
) => readonly RegisteredPrimitive[];

const registrars = new Map<PrimitiveKind, ModuleRegistrar>();

/**
 * Announce the registrar for `kind`, once per process. Re-announcing the same function is a
 * no-op (a module re-evaluated under a different specifier); announcing a *different* one
 * means two copies of the owning package are loaded, each with its own registry — half the
 * primitives would register into a table nothing else reads.
 */
export function registerPrimitiveRegistrar(kind: PrimitiveKind, registrar: ModuleRegistrar): void {
  const existing = registrars.get(kind);
  if (existing !== undefined && existing !== registrar) {
    throw new UltimateError({
      code: 'X_REGISTRAR_CONFLICT',
      cause: `two different ${kind} registrars are loaded, so ${kind} primitives would split across two registries`,
      // One command, because a `fix:` is pasted verbatim: collapsing every range on the package
      // to one resolved version is the repair. `bun pm why @ultimat3/<kind>` names the dependents
      // when a range genuinely disagrees and the update cannot converge on its own.
      fix: `bun update @ultimat3/${kind}`,
      meta: { kind },
    });
  }
  registrars.set(kind, registrar);
}

export function hasPrimitiveRegistrar(kind: PrimitiveKind): boolean {
  return registrars.has(kind);
}

/**
 * The registrar for `kind`. Throws rather than returning `undefined`: a caller that skipped a
 * missing registrar would drop every primitive of that kind silently, which is exactly the
 * failure this seam exists to make impossible.
 */
export function primitiveRegistrar(kind: PrimitiveKind): ModuleRegistrar {
  const registrar = registrars.get(kind);
  if (registrar === undefined) {
    throw new UltimateError({
      code: 'X_REGISTRAR_MISSING',
      cause: `no ${kind} registrar is loaded, so ${kind} primitives cannot be registered`,
      fix: `bun add @ultimat3/${kind}`,
      meta: { kind },
    });
  }
  return registrar;
}

/** Test-only. Production announces once at import and never withdraws. */
export function resetPrimitiveRegistrars(): void {
  registrars.clear();
}
