// The process registries a test file inherits, captured and handed back at the file boundary;
// `registry-leak-guard.ts` owns WHEN. A snapshot rather than a reset to defaults, because what a
// module declares at MODULE scope evaluates once per `bun test` process — a neighbour's clear is
// permanent and there is no second evaluation left to redo it.

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
