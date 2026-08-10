// Single responsibility: the seam that lets one package hand a module of primitives to the
// package that owns them, without a sideways import.
//
// `action` and `query` sit on the same tier, so `defineApi` in `@ultimat3/action` cannot
// import `registerQueries` — the boundaries check is a build error, not a suggestion. Each
// owning package announces its registrar here at import time; a caller asks by kind. Same
// shape as `defineService` and `registerErrorCodes`: core holds the table, higher tiers fill
// it, and nobody imports sideways to reach it.

import { UltimateError } from './errors';

/** The eight primitives. A registrar exists only for the kinds registered by module. */
export type PrimitiveKind =
  | 'action'
  | 'entity'
  | 'job'
  | 'mutator'
  | 'policy'
  | 'query'
  | 'route'
  | 'task';

/** `registerActions` / `registerQueries`: export names become primitive names. */
export type ModuleRegistrar = (module: Readonly<Record<string, unknown>>) => readonly unknown[];

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
      fix: `bun pm ls | grep @ultimat3/${kind} — then dedupe it to one version in package.json`,
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
