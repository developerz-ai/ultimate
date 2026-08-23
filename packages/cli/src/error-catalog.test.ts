// The catalog's only job is completeness, so the test that matters is the one that fails when a
// new package is added: the list is checked against the workspace on disk, not against itself.

import { describe, expect, test } from 'bun:test';
// `node:` by necessity: Bun exposes no path-join primitive. `import.meta.dir` gives the directory
// this file is in, and joining the repo root onto it still needs `node:path`.
import { join } from 'node:path';
import { hasErrorCode, listErrorCodes } from '@ultimat3/core';
import {
  buildErrorCatalog,
  CATALOG_OPTIONAL_HOSTS,
  CATALOG_PACKAGES,
  loadErrorCatalog,
  registeredErrorCodes,
} from './error-catalog';
import { CLI_ERROR_CODES } from './error-codes';
import { stripComments } from './ts-scan';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** Every workspace package that declares codes — `cli` excluded, it registers its own. */
async function packagesWithErrorCodes(): Promise<readonly string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob('packages/*/src/errors.ts').scan({ cwd: REPO_ROOT })) {
    const name = path.split('/')[1] ?? '';
    if (name !== 'cli' && name.length > 0) found.push(`@ultimat3/${name}`);
  }
  return found.sort();
}

describe('unit · the catalog list', () => {
  test('covers every workspace package that owns error codes', async () => {
    const expected = await packagesWithErrorCodes();
    // Read into `string[]` first: `CATALOG_PACKAGES` is a readonly tuple of package-name literals,
    // so the matcher would only accept that same literal union back — never a scanned list.
    const declared: readonly string[] = [...CATALOG_PACKAGES].sort();
    expect(declared).toEqual(expected);
  });

  test('never names a package twice — a duplicate import is a silent no-op', () => {
    expect(new Set(CATALOG_PACKAGES).size).toBe(CATALOG_PACKAGES.length);
  });

  test('excludes the CLI itself, whose errors.ts registers at import', () => {
    expect(CATALOG_PACKAGES).not.toContain('@ultimat3/cli');
  });

  /**
   * The list is a runtime import graph written as strings, so `bun run boundaries` — which reads
   * import STATEMENTS — cannot see any of it, and neither can `checkWorkspaceDependencies`. Four
   * entries were undeclared for that reason: in this repo they resolve through workspace symlinks,
   * in an installed app they resolve only if the app happens to depend on them, and `x errors
   * explain X_FLAG_EXPIRED` then answers `X_ERROR_CODE_UNKNOWN` for a code `wiki/Error-Codes.md`
   * promises resolves. Derived from the manifest on disk, never a second hand-kept list.
   */
  test('every package it imports is a declared dependency, bar the two optional hosts', async () => {
    const manifest = (await Bun.file(
      join(import.meta.dir, '..', 'package.json'),
    ).json()) as CliManifest;
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const undeclared = CATALOG_PACKAGES.filter(
      (name) => !declared.has(name) && !CATALOG_OPTIONAL_HOSTS.includes(name),
    );
    expect(undeclared).toEqual([]);
  });

  test('the optional hosts are packages the catalog actually imports', () => {
    for (const host of CATALOG_OPTIONAL_HOSTS) {
      expect(CATALOG_PACKAGES).toContain(host as (typeof CATALOG_PACKAGES)[number]);
    }
  });
});

/** The one field of `packages/cli/package.json` this file reads — parsed, never asserted with `any`. */
interface CliManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

describe('unit · loading it', () => {
  // Imports EVERY `@ultimat3/*` package, which is the point — and the reason Bun's 5s default no
  // longer covers it. `x verify` shards its test steps across worker processes now, so this test
  // shares its cores with up to seven other `bun test` children, and which shard it lands in
  // depends on the file count. Left alone it fails intermittently in CI rather than slowly here.
  // The load is the coverage, so the timeout is what moves. Same shape as
  // `error-contract.test.ts` and `scripts/verify.test.ts`.
  test('registers codes the CLI graph never imports on its own', async () => {
    await loadErrorCatalog();
    // auth, pwa and money are reachable from no `x` command, so only the catalog puts them here.
    expect(hasErrorCode('X_UNAUTHENTICATED')).toBe(true);
    expect(hasErrorCode('X_PWA_ICON_MISSING')).toBe(true);
    expect(hasErrorCode('X_CURRENCY_UNKNOWN')).toBe(true);
  }, 30_000);

  test('reports what it could not import rather than dropping it silently', async () => {
    const catalog = await loadErrorCatalog();
    const seen = [...catalog.loaded, ...catalog.unavailable, ...catalog.failed.map((f) => f.at)];
    expect(seen.sort()).toEqual([...CATALOG_PACKAGES].sort());
    // Anything unavailable must be a package on the list, never an invented name.
    for (const specifier of catalog.unavailable) {
      expect(CATALOG_PACKAGES).toContain(specifier as (typeof CATALOG_PACKAGES)[number]);
    }
  });

  // Not a formality: an initialization failure here is a real package defect — a duplicate code, a
  // registration the registry refuses — and the old catch-everything reported it as a missing
  // module, so `x errors` answered from a partial table with no cause and nothing to run.
  test('no framework package fails to initialize in this repo', async () => {
    expect((await loadErrorCatalog()).failed).toEqual([]);
  });

  test('is memoised — the registry is process-global, so once is enough', async () => {
    const first = loadErrorCatalog();
    expect(loadErrorCatalog()).toBe(first);
    await first;
  });
});

describe('unit · a package that will not load', () => {
  const loaderFailing = (target: string, thrown: unknown) => async (specifier: string) => {
    if (specifier === target) throw thrown;
    return {};
  };

  // The shape Bun raises for `@ultimat3/ui`, whose JSX runtime a bare CLI process does not have.
  const unresolved = { code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find module 'react/jsx'" };

  test('an unresolvable module is the documented host gap, not a defect', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/ui', unresolved));
    expect(catalog.unavailable).toEqual(['@ultimat3/ui']);
    expect(catalog.failed).toEqual([]);
    expect(catalog.loaded).not.toContain('@ultimat3/ui');
  });

  test('a package that throws while initializing keeps its code, cause and fix', async () => {
    const duplicate = {
      code: 'X_ERROR_CODE_DUPLICATE',
      cause: 'already registered: X_DB_DRIFT',
      fix: "rename the colliding code in the registering package's src/errors.ts",
    };
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/db', duplicate));
    expect(catalog.unavailable).toEqual([]);
    expect(catalog.failed).toEqual([
      {
        code: 'X_ERROR_CODE_DUPLICATE',
        cause: '@ultimat3/db failed to initialize: already registered: X_DB_DRIFT',
        fix: "rename the colliding code in the registering package's src/errors.ts",
        at: '@ultimat3/db',
      },
    ]);
  });

  // The bare Errors below are the subject: a module that will not import throws whatever the
  // runtime threw — a syntax error, a missing native — and never an `X_*` code. Coding them would
  // test the branch two cases above this one, which is the one that already covers coded failures.
  // The class name travels with the message because for THIS failure it is the informative half:
  // `SyntaxError` and `TypeError` name two different repairs, and `renderThrowable` is the one
  // spelling every surface uses — `toUltimateError` and `finalizeFailed` already printed it.
  test('an unstructured throw still names the package that broke', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/mail', new Error('boom')));
    const [finding] = catalog.failed;
    expect(finding?.at).toBe('@ultimat3/mail');
    expect(finding?.cause).toBe('@ultimat3/mail failed to initialize: Error: boom');
    expect(finding?.fix.length).toBeGreaterThan(0);
  });

  test('every package still lands in exactly one bucket', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/db', new Error('boom')));
    const seen = [...catalog.loaded, ...catalog.unavailable, ...catalog.failed.map((f) => f.at)];
    expect(seen.sort()).toEqual([...CATALOG_PACKAGES].sort());
  });

  test('registeredErrorCodes answers with the loaded registry, not a second table', async () => {
    const codes = await registeredErrorCodes();
    expect(codes.has('X_UNAUTHENTICATED')).toBe(true);
    expect(codes.has('X_NOPE')).toBe(false);
    expect(codes.size).toBe(listErrorCodes().length);
  });
});

/**
 * `X_*` string literals that are not error codes. Both are environment variable *names* that the
 * `X_` prefix makes indistinguishable from a code by shape alone. The list is three entries long
 * on purpose: a fourth wants a reason written next to it, not a widened pattern.
 */
const NOT_ERROR_CODES: ReadonlySet<string> = new Set(['X_ENV', 'X_BUILD_ID']);

/**
 * The hole this closes: `scanCodes` — and so `X_ERROR_CODE_UNDOCUMENTED` — reads `code:` keys and
 * a package's own registry file, which is every code that is *thrown*. A code handed to a reader
 * some other way (`finding('X_PORT_IN_USE', …)` positionally, `{ error: 'X_ADMIN_DENIED' }` on a
 * result object) was invisible to every gate: unregistered, so `x errors explain` refused it, and
 * undocumented, because the check that demands a row never saw it either. Registration is what
 * makes a code real, so a literal in shipped source that nothing registered is the defect.
 */
describe('unit · every code shipped source hands a reader is registered', () => {
  test('no X_* literal in packages/*/src escapes the registry', async () => {
    await loadErrorCatalog();
    // The catalog excludes `@ultimat3/cli` — it registers its own at import, which in this process
    // means when something reads from `./errors`. That read is this line.
    expect(CLI_ERROR_CODES.every((code) => hasErrorCode(code))).toBe(true);
    const orphans = new Map<string, string>();
    for await (const path of new Bun.Glob('packages/*/src/**/*.ts').scan({ cwd: REPO_ROOT })) {
      if (path.endsWith('.test.ts') || path.endsWith('.d.ts')) continue;
      const text = stripComments(await Bun.file(join(REPO_ROOT, path)).text());
      for (const match of text.matchAll(/(['"`])(X_[A-Z0-9_]+)\1/g)) {
        const code = match[2] as string;
        if (NOT_ERROR_CODES.has(code) || hasErrorCode(code) || orphans.has(code)) continue;
        orphans.set(code, path);
      }
    }
    expect([...orphans.entries()]).toEqual([]);
    // Loads every package AND walks every shipped source file in the monorepo — the same reason
    // the test above carries an explicit budget rather than Bun's 5s default.
  }, 30_000);
});
