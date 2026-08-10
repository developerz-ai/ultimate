// Every framework package's error codes, present in this process before `x errors` answers.
// A package registers its titles when it is imported, and the CLI only imports the packages its
// commands actually need — so without this, `x errors explain X_UNAUTHENTICATED` answered "not a
// registered error code" for a code the framework throws on every unauthenticated request.

import { hasErrorCode, registerErrorCodes } from '@ultimat3/core';
import { SCHEMA_ERROR_CODES } from '@ultimat3/schema';

/**
 * Every `@ultimat3/*` package that owns `X_*` codes, `cli` excluded — `errors.ts` registers its
 * own at import. Importing one already in the graph is a module-cache hit, so the list needs no
 * knowledge of which commands pulled what. `error-catalog.test.ts` asserts it against the
 * workspace, which is what stops a new package from silently missing its codes.
 */
export const CATALOG_PACKAGES = [
  '@ultimat3/action',
  '@ultimat3/admin',
  '@ultimat3/ai',
  '@ultimat3/auth',
  '@ultimat3/cache',
  '@ultimat3/core',
  '@ultimat3/db',
  '@ultimat3/entity',
  '@ultimat3/http',
  '@ultimat3/i18n',
  '@ultimat3/jobs',
  '@ultimat3/mail',
  '@ultimat3/manifest',
  '@ultimat3/mcp',
  '@ultimat3/money',
  '@ultimat3/policy',
  '@ultimat3/pwa',
  '@ultimat3/query',
  '@ultimat3/realtime',
  '@ultimat3/render',
  '@ultimat3/schema',
  '@ultimat3/seo',
  '@ultimat3/storage',
  '@ultimat3/testing',
  '@ultimat3/time',
  '@ultimat3/ui',
] as const;

export interface ErrorCatalog {
  /** Packages whose codes are now registered. */
  readonly loaded: readonly string[];
  /**
   * Packages this process could not import, so their codes are absent from the answer. Reported
   * rather than swallowed: `@ultimat3/ui` needs a JSX runtime an app has and a bare CLI does not,
   * and a list silently missing three codes is worse than one that says which three are missing.
   */
  readonly unavailable: readonly string[];
}

let cached: Promise<ErrorCatalog> | undefined;

/**
 * `@ultimat3/schema` is tier 0 alongside `core`, so it cannot register its own codes — it exports
 * the declarations and names the CLI as the package that may import both tiers. This is that.
 */
function registerSchemaCodes(): void {
  for (const [code, declaration] of Object.entries(SCHEMA_ERROR_CODES)) {
    if (!hasErrorCode(code)) registerErrorCodes({ [code]: declaration });
  }
}

async function importAll(): Promise<ErrorCatalog> {
  registerSchemaCodes();
  const loaded: string[] = [];
  const unavailable: string[] = [];
  await Promise.all(
    CATALOG_PACKAGES.map(async (specifier) => {
      try {
        await import(specifier);
        loaded.push(specifier);
      } catch {
        unavailable.push(specifier);
      }
    }),
  );
  return { loaded: loaded.sort(), unavailable: unavailable.sort() };
}

/** Memoised: the registry is process-global, so the imports are worth paying for exactly once. */
export function loadErrorCatalog(): Promise<ErrorCatalog> {
  cached ??= importAll();
  return cached;
}

/** Test seam — the counterpart to every other reset in this package. */
export function resetErrorCatalog(): void {
  cached = undefined;
}
