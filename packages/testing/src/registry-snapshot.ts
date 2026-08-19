// WHAT the harness puts back at a test-file boundary; `registry-leak-guard.ts` owns WHEN.
// A process global written at MODULE scope cannot be replayed — a module evaluates once per
// `bun test` process — so a file that clears or narrows one decides what every file after it
// sees, and the failure lands on an innocent suite in another package.
//
// Relative specifiers, for `scripts/test-setup.ts`'s own reason: this module is reached from a
// preload, which runs before anything else and must not depend on workspace symlinks. Both edges
// point DOWN the tier table (testing is 5, i18n is 1, policy is 2), so nothing here is sideways.
// Module by module rather than through either barrel, for the reason `src/index.ts` states over
// `isolateEntityRegistry`: `registry-leak-guard.ts` IS on that barrel, so a `packages/core` test
// importing this package for `expect` alone would otherwise flatten `catalogs/en.json` on the way.

import type { Catalog, Locale, LocaleConfig } from '@ultimat3/i18n';
import {
  catalogFor,
  configureLocales,
  localeConfig,
  registerCatalog,
  registeredLocales,
  resetCatalogs,
} from '@ultimat3/i18n';
import type { RoleMap } from '@ultimat3/policy';
import {
  knownPermissions,
  restorePermissions,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
} from '@ultimat3/policy';

/**
 * Every member is captured by value or by a reference its owner replaces rather than mutates
 * (`configureLocales`, `defineRoles` and `registerCatalog` all build a new object and assign it),
 * so a snapshot describes the process at the instant it was taken and no later write reaches it.
 */
export interface ProcessRegistrySnapshot {
  readonly locales: LocaleConfig;
  readonly catalogs: readonly (readonly [Locale, Catalog])[];
  readonly permissions: readonly string[];
  readonly roles: RoleMap;
  /** Kept beside the map: restoring through `defineRoles()` would rewrite every site. */
  readonly roleSites: Readonly<Record<string, string>>;
}

export function captureProcessRegistries(): ProcessRegistrySnapshot {
  return {
    locales: localeConfig(),
    catalogs: registeredLocales().map((locale) => [locale, catalogFor(locale)] as const),
    permissions: knownPermissions(),
    roles: roleDefinitions(),
    roleSites: roleDeclarationSites(),
  };
}

/**
 * Idempotent, and a REPLACE on every registry rather than a merge: a snapshot is the whole truth
 * about the process at capture time, so anything declared since must go as surely as anything
 * cleared since must come back.
 */
export function restoreProcessRegistries(snapshot: ProcessRegistrySnapshot): void {
  // A full `LocaleConfig`, so the merge `configureLocales` performs replaces all three fields —
  // a partial call can never widen `supported` back.
  configureLocales(snapshot.locales);
  resetCatalogs();
  for (const [locale, catalog] of snapshot.catalogs) registerCatalog(locale, catalog);
  restorePermissions(snapshot.permissions);
  restoreRoles(snapshot.roles, snapshot.roleSites);
}
