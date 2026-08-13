// Every framework package's error codes, present in this process before `x errors` answers.
// A package registers its titles when it is imported, and the CLI only imports the packages its
// commands actually need — so without this, `x errors explain X_UNAUTHENTICATED` answered "not a
// registered error code" for a code the framework throws on every unauthenticated request.

import { listErrorCodes } from '@ultimat3/core';
import type { Finding } from './output';
import { findingFrom } from './output';

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
  '@ultimat3/flags',
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
   * Packages this process could not *resolve*, so their codes are absent from the answer. The one
   * tolerated case is the optional host: `@ultimat3/ui` and `@ultimat3/admin` reach for a JSX
   * runtime an app has and a bare CLI process does not, and a list silently missing their codes is
   * worse than one that says which packages are missing. A package that resolved and then threw is
   * a defect, not a host gap, and goes to `failed`.
   */
  readonly unavailable: readonly string[];
  /**
   * Packages that resolved and threw while initializing — a duplicate code, an invalid
   * registration, a module that cannot evaluate. Carried with the thrown error's own code, cause
   * and fix so `x errors` reports them as findings: reporting a package defect as merely
   * "unavailable" is a partial catalog with no cause and nothing to run.
   */
  readonly failed: readonly Finding[];
}

let cached: Promise<ErrorCatalog> | undefined;

/**
 * Bun reports an unresolvable specifier as a `ResolveMessage` carrying `ERR_MODULE_NOT_FOUND` —
 * the host gap. Anything else escaped the package's own module evaluation and is its defect.
 */
const isUnresolved = (thrown: unknown): boolean =>
  typeof thrown === 'object' &&
  thrown !== null &&
  'code' in thrown &&
  thrown.code === 'ERR_MODULE_NOT_FOUND';

/** The package's own error, named and located, so the report says what broke and what to run. */
function initFailure(specifier: string, thrown: unknown): Finding {
  const finding = findingFrom(thrown);
  return {
    ...finding,
    cause: `${specifier} failed to initialize: ${finding.cause}`,
    at: specifier,
  };
}

/**
 * Test seam: the catalog over an injected loader. `loadErrorCatalog()` hands it `import()`; a test
 * hands it one that throws, which is the only way to reach the failure paths in a repo where every
 * package initializes.
 */
export async function buildErrorCatalog(
  load: (specifier: string) => Promise<unknown>,
): Promise<ErrorCatalog> {
  const loaded: string[] = [];
  const unavailable: string[] = [];
  const failed: Finding[] = [];
  await Promise.all(
    CATALOG_PACKAGES.map(async (specifier) => {
      try {
        await load(specifier);
        loaded.push(specifier);
      } catch (thrown) {
        if (isUnresolved(thrown)) unavailable.push(specifier);
        else failed.push(initFailure(specifier, thrown));
      }
    }),
  );
  return {
    loaded: loaded.sort(),
    unavailable: unavailable.sort(),
    failed: failed.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
  };
}

/**
 * `@ultimat3/schema`'s codes are registered by `@ultimat3/core` itself now (`schema-error-codes.ts`)
 * — every process that imports core gets them, this CLI process included, just by importing
 * `@ultimat3/core` at all. Nothing schema-specific happens here any more.
 */
async function importAll(): Promise<ErrorCatalog> {
  return buildErrorCatalog((specifier) => import(specifier));
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

/**
 * Every code `x errors explain` can answer for, as a set. The `errors` step checks the reference
 * page against exactly this: a documented code missing from here is one an agent can read but not
 * look up. Loads the catalog first, so the answer does not depend on which commands ran before it.
 */
export async function registeredErrorCodes(): Promise<ReadonlySet<string>> {
  await loadErrorCatalog();
  return new Set(listErrorCodes().map((entry) => entry.code));
}
