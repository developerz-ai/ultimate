// The process registries a test file inherits, captured and handed back at the file boundary;
// `registry-leak-guard.ts` owns WHEN. A snapshot rather than a reset to defaults, because what a
// module declares at MODULE scope evaluates once per `bun test` process — a neighbour's clear is
// permanent and there is no second evaluation left to redo it.
//
// FOUR registries, out of roughly nine that publish a `clear*`/`reset*`. The missing ones and what
// each still needs are tabulated in `registry-leak-guard.ts` beside `RegistrySample` — every one of
// them needs a RESTORE in its owning package first, the way `restorePermissions` / `restoreRoles`
// were added to `@ultimat3/policy` for the two rows below.

import type { Catalog, Locale, LocaleConfig } from '@ultimat3/i18n';
import {
  catalogFor,
  configureLocales,
  localeConfig,
  mergeCatalogs,
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
 * Idempotent. A REPLACE on the locale config, the permission set and the role map — a snapshot is
 * the whole truth about those at capture time — and, for the catalogs alone, a key-level
 * RECONCILE. See `restoreCatalogs`.
 */
export function restoreProcessRegistries(snapshot: ProcessRegistrySnapshot): void {
  // A full `LocaleConfig`, so the merge `configureLocales` performs replaces all three fields —
  // a partial call can never widen `supported` back.
  configureLocales(snapshot.locales);
  restoreCatalogs(snapshot.catalogs);
  restorePermissions(snapshot.permissions);
  restoreRoles(snapshot.roles, snapshot.roleSites);
}

/**
 * Repair a clear; never undo a registration. The catalogs are the one registry here restored by
 * MERGE rather than by replacement, and the module cache is why.
 *
 * `registerCatalog` has no inverse — it merges, last wins — so the only thing a file can do that
 * costs the next file anything is `resetCatalogs()`, and that is exactly what this repairs: a key
 * the snapshot holds and the live registry has lost comes back. Everything the live registry still
 * holds is left alone, INCLUDING a key whose value the file changed.
 *
 * Undoing the change is what the first attempt at #312 did, and it is wrong twice over. A key
 * first registered during the file cannot be re-added by anyone: `loadApp()` inside a test body
 * dynamically imports the app's i18n package, `defineCatalogs()` there is MODULE scope — once per
 * `bun test` process — so dropping the app's 519 keys left every later file's own `import` a cache
 * hit that declares nothing and `t('brand.name')` answering `⟦brand.name⟧` for the rest of the run.
 * And a key it OVERRODE is the same declaration read one layer down: the demo app's
 * `admin.denied.body` overrides `@ultimat3/i18n`'s own base string, so reverting to the inherited
 * value rendered the framework's `This account is missing admin:read` in place of the app's copy —
 * a green `⟦…⟧` sweep hiding the identical defect.
 *
 * The cost is stated rather than hidden: a file that deliberately CLOBBERS an inherited key leaves
 * that value for the next file. Its cleanup is the one this repair is built around — `resetCatalogs()`
 * in the file's own `afterAll`, which drops its layer and lets the boundary put back what that clear
 * took from everyone else.
 */
function restoreCatalogs(snapshot: readonly (readonly [Locale, Catalog])[]): void {
  const inherited = new Map(snapshot);
  const live = new Map(registeredLocales().map((locale) => [locale, catalogFor(locale)] as const));
  // Cleared first so the merge order below is this function's to choose: `registerCatalog` puts
  // its argument last, which would otherwise let the inherited value win the keys it shares.
  resetCatalogs();
  for (const locale of new Set([...inherited.keys(), ...live.keys()])) {
    registerCatalog(locale, mergeCatalogs(inherited.get(locale) ?? {}, live.get(locale) ?? {}));
  }
}
