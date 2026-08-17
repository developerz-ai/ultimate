import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './boundaries';
import {
  adminFlattenerFindingFor,
  checkAdminFlattener,
  checkBoundaries,
  checkSharedLeaf,
  collectAdminFiles,
  collectSharedFiles,
  collectSourceFiles,
  findingFor,
  packageOf,
  resolveSpecifier,
  scopedName,
  sharedLeafFindingFor,
  surfaceOf,
} from './boundaries';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkTier, tierOf } from './lib/tiers';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · boundaries', () => {
  test('an upward import is a violation naming the file, the import and the allowed tiers', () => {
    const violations = checkBoundaries([
      file('packages/core/src/index.ts', "import { render } from '@ultimat3/render';"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'packages/core/src/index.ts',
      from: 'core',
      to: 'render',
      fromTier: 0,
      toTier: 4,
      reason: 'upward',
      allowedTiers: '0-0',
    });
  });

  test('the violation renders as a finding with a code, a cause and a fix', () => {
    const violation = checkBoundaries([
      file('packages/http/src/server.ts', "import { db } from '@ultimat3/query';"),
    ])[0];
    if (violation === undefined) throw new Error('expected a violation');
    const finding = findingFor(violation);
    expect(finding.code).toBe('X_BOUNDARY_VIOLATION');
    expect(finding.cause).toContain('http (tier 2) imports @ultimat3/query (tier 3)');
    expect(finding.cause).toContain('allowed: 0-1');
    expect(finding.fix.length).toBeGreaterThan(0);
    expect(finding.at).toBe('packages/http/src/server.ts');
  });

  test('a sideways import inside one tier is a violation', () => {
    const violations = checkBoundaries([
      file('packages/action/src/index.ts', "import { subscribe } from '@ultimat3/realtime';"),
    ]);
    expect(violations[0]?.reason).toBe('same-tier');
  });

  test('a strictly lower import is allowed', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/errors.ts', "import { UltimateError } from '@ultimat3/core';"),
        file('packages/policy/src/can.ts', "import { t } from '@ultimat3/i18n';"),
      ]),
    ).toEqual([]);
  });

  test('the one declared sideways edge is allowed and nothing else is', () => {
    expect(
      checkBoundaries([
        file('packages/create-ultimate/src/index.ts', "import { dispatch } from '@ultimat3/cli';"),
      ]),
    ).toEqual([]);
    expect(
      checkBoundaries([
        file('packages/testing/src/harness.ts', "import { dispatch } from '@ultimat3/cli';"),
      ])[0]?.reason,
    ).toBe('same-tier');
  });

  test('an import of a package that is not in the tier table is a violation, not a shrug', () => {
    const violations = checkBoundaries([
      file('packages/cli/src/index.ts', "import { thing } from '@ultimat3/not-a-package';"),
    ]);
    const violation = violations[0];
    if (violation === undefined) throw new Error('expected a violation');
    expect(violation.reason).toBe('unknown-package');
    expect(findingFor(violation).fix).toContain('scripts/lib/tiers.ts');
  });

  // Inverted deliberately. This used to assert that a type-only import "does not count", which is
  // the hole: `scanImports` erases the statement, so tier 0 could name tier 5 and the script
  // reported clean — while CLAUDE.md says a tier violation is a build error, full stop.
  test('a type-only import is a violation: the erased statement still couples two packages', () => {
    const violations = checkBoundaries([
      file('packages/core/src/types.ts', "import type { Route } from '@ultimat3/render';"),
    ]);
    expect(violations[0]).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
  });

  test('`export type … from` is caught too, and a type ALIAS is left alone', () => {
    expect(
      checkBoundaries([
        file('packages/schema/src/index.ts', "export type { CliCommand } from '@ultimat3/cli';"),
      ])[0]?.to,
    ).toBe('cli');
    // `export type Foo = string` is not an import; rewriting it would be a syntax error that the
    // transpiler reports instead of the imports this pass exists to find.
    expect(
      checkBoundaries([
        file(
          'packages/render/src/value.ts',
          "export type InterpolationValue = string | number;\nimport { x } from '@ultimat3/core';",
        ),
      ]),
    ).toEqual([]);
  });

  /**
   * The INLINE spelling of the same statement. `dropTypeKeyword` only ever removed the keyword
   * form, so `import { type Foo } from '@ultimat3/cli'` in a tier-0 file was erased by the
   * transpiler and reported clean — the identical edge, spelled the way `useImportType` rewrites
   * a mixed list to. `import { A, type B }` was already seen, which is what made the gap look shut.
   */
  test('an all-inline `{ type X }` import is the same violation as `import type`', () => {
    expect(
      checkBoundaries([
        file('packages/core/src/types.ts', "import { type Route } from '@ultimat3/render';"),
      ])[0],
    ).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
    expect(
      checkBoundaries([
        file('packages/schema/src/index.ts', "export { type CliCommand } from '@ultimat3/cli';"),
      ])[0],
    ).toMatchObject({ from: 'schema', to: 'cli', reason: 'upward' });
    // Several specifiers, a rename, and a multi-line list: all still one import of one package.
    expect(
      checkBoundaries([
        file(
          'packages/core/src/many.ts',
          "import {\n  type Route,\n  type Mode as M,\n} from '@ultimat3/render';",
        ),
      ])[0],
    ).toMatchObject({ to: 'render', reason: 'upward' });
  });

  test('the inline rewrite leaves a lower-tier import and a local type alias alone', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/x.ts', "import { type UltimateError } from '@ultimat3/core';"),
        // `type` as an ordinary binding name is not a modifier, and neither is a property called
        // `type` in an object literal — rewriting either would change what the parser reads.
        file('packages/core/src/y.ts', "import { type } from './kind';\nexport const k = type;"),
        file('packages/core/src/z.ts', "export const step = { type: 'unit' };"),
      ]),
    ).toEqual([]);
  });

  test('a type-only import inside a template literal is not this file’s import', () => {
    // packages/cli/src/templates/*.ts emit generated app source. A regex over raw text would read
    // the generated line as cli's own; the transpiler still sees a string.
    expect(
      checkBoundaries([
        file(
          'packages/core/src/template.ts',
          "export const page = () => `import type { Route } from '@ultimat3/render';`;",
        ),
      ]),
    ).toEqual([]);
  });

  test('a RELATIVE cross-package import is checked exactly like the package specifier', () => {
    const violations = checkBoundaries([
      file('packages/core/src/x.ts', "import { render } from '../../render/src/index';"),
    ]);
    expect(violations[0]).toMatchObject({ from: 'core', to: 'render', reason: 'upward' });
    // A relative path INSIDE the package is still not a cross-package import.
    expect(
      checkBoundaries([file('packages/core/src/x.ts', "import { y } from './sibling';")]),
    ).toEqual([]);
  });

  test('the declared cli -> testing edge is what serve.live.test.ts imports through', () => {
    expect(
      checkBoundaries([
        file(
          'packages/cli/src/serve.live.test.ts',
          "import { allowHost } from '@ultimat3/testing';",
        ),
      ]),
    ).toEqual([]);
    // …and the relative spelling of the same edge resolves to the same verdict, rather than
    // being invisible the way it was.
    expect(
      checkBoundaries([
        file(
          'packages/cli/src/serve.live.test.ts',
          "import { allowHost } from '../../testing/src/sealed-network';",
        ),
      ]),
    ).toEqual([]);
  });

  test('create-ultimate may import its declared edge and nothing else', () => {
    expect(
      checkBoundaries([
        file('packages/create-ultimate/src/index.ts', "import { dispatch } from '@ultimat3/cli';"),
      ]),
    ).toEqual([]);
    // Above tier 5 used to mean "every framework package is a legal lower-tier import", which made
    // the declared edge restrict nothing at all.
    const violation = checkBoundaries([
      file(
        'packages/create-ultimate/src/index.ts',
        "import { defineRoute } from '@ultimat3/render';",
      ),
    ])[0];
    expect(violation?.reason).toBe('edge-only');
    expect(findingFor(violation as NonNullable<typeof violation>).cause).toContain(
      'allowed: only @ultimat3/cli',
    );
  });

  test('dynamic imports and re-exports are checked too', () => {
    const dynamic = checkBoundaries([
      file('packages/core/src/lazy.ts', "export const load = () => import('@ultimat3/render');"),
    ]);
    expect(dynamic[0]?.to).toBe('render');
    const reexport = checkBoundaries([
      file('packages/core/src/index.ts', "export { render } from '@ultimat3/render';"),
    ]);
    expect(reexport[0]?.to).toBe('render');
  });

  test('a package importing its own subpath is not a violation', () => {
    expect(
      checkBoundaries([
        file('packages/cli/src/index.ts', "import { x } from '@ultimat3/cli/templates';"),
      ]),
    ).toEqual([]);
  });

  test('files outside packages/*/src are not subject to the table', () => {
    expect(packageOf('scripts/verify.ts')).toBeUndefined();
    expect(packageOf('packages/cli/src/bin.ts')).toBe('cli');
    expect(scopedName('@ultimat3/http')).toBe('http');
    expect(scopedName('node:fs')).toBeUndefined();
  });

  test('the table itself agrees with the contract', () => {
    expect(tierOf('core')).toBe(0);
    expect(tierOf('cli')).toBe(5);
    expect(checkTier('cli', 'core').allowed).toBe(true);
    expect(checkTier('core', 'cli').allowed).toBe(false);
    expect(checkTier('ui', 'admin').allowed).toBe(false);
  });
});

const LEAF = 'examples/dummy/apps/web/shared/client.ts';

describe('unit · shared/ is a leaf', () => {
  test('a VALUE import into app/ is a violation naming the file, the import and the surface', () => {
    const leaks = checkSharedLeaf([
      file(LEAF, "import { publishPost } from '../app/posts/actions';"),
    ]);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({
      file: LEAF,
      specifier: '../app/posts/actions',
      surface: 'app',
    });
  });

  test('the same import as `import type` is NOT a violation — that is the whole rule', () => {
    expect(
      checkSharedLeaf([
        file(LEAF, "import type { PostView } from '../app/posts/entity';"),
        file(
          'examples/dummy/apps/web/shared/services.ts',
          "import type { X } from '../app/orgs/entity';",
        ),
      ]),
    ).toEqual([]);
  });

  test('the leak renders as a finding with a code, a cause and a runnable fix', () => {
    const leak = checkSharedLeaf([file(LEAF, "export { feed } from '../app/feed';")])[0];
    expect(leak).toBeDefined();
    if (leak === undefined) return;
    const finding = sharedLeafFindingFor(leak);
    expect(finding.code).toBe('X_BOUNDARY_SHARED_LEAF');
    expect(finding.cause).toContain('runtime import of "../app/feed"');
    expect(finding.cause).toContain('shared/ is a leaf');
    expect(finding.fix).toContain('import type');
    expect(finding.at).toBe(LEAF);
  });

  test('site/ is closed to the leaf too, and a dynamic import counts', () => {
    const leaks = checkSharedLeaf([
      file(LEAF, "export const load = () => import('../site/pricing');"),
    ]);
    expect(leaks[0]).toMatchObject({ specifier: '../site/pricing', surface: 'site' });
  });

  test('api/, packages and bare specifiers stay legal for a leaf', () => {
    expect(
      checkSharedLeaf([
        file(LEAF, "import { boot } from '../api';"),
        file(
          'examples/dummy/apps/web/shared/policies.ts',
          "import { allow } from '@ultimat3/policy';",
        ),
        file('examples/dummy/apps/web/shared/entities.ts', "import { x } from './viewer';"),
      ]),
    ).toEqual([]);
  });

  test('only shared/ is subject to the rule — app/ may import app/', () => {
    expect(
      checkSharedLeaf([
        file('examples/dummy/apps/web/app/feed.tsx', "import { x } from './posts/live';"),
        file('packages/core/src/index.ts', "import { x } from '../app/thing';"),
      ]),
    ).toEqual([]);
  });

  test('surfaces and relative specifiers resolve from the path, not from a guess', () => {
    expect(surfaceOf(LEAF)).toBe('shared');
    expect(surfaceOf('examples/dummy/packages/db/src/tags.ts')).toBeUndefined();
    expect(resolveSpecifier(LEAF, '../app/posts/actions')).toBe(
      'examples/dummy/apps/web/app/posts/actions',
    );
    expect(resolveSpecifier(LEAF, '@ultimat3/action')).toBe('@ultimat3/action');
  });

  // A checker pointed at an empty file list passes forever. That is how a rule dies quietly, so
  // the glob is pinned to a leaf that exists rather than trusted.
  test('the collector actually finds the reference app leaf, and it is clean today', async () => {
    const files = await collectSharedFiles(repoRoot());
    expect(files.map((entry) => entry.path)).toContain(LEAF);
    expect(checkSharedLeaf(files)).toEqual([]);
  });

  // The demo app is the one CI publishes an image for on every push to main, and its 8 shared/
  // modules were outside the glob — checked by nothing blocking.
  test('the collector reaches the DEPLOYED demo app’s shared/ too', async () => {
    const paths = (await collectSharedFiles(repoRoot())).map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith('dummy/social-media-clone/apps/web/shared/'))).toBe(
      true,
    );
  });
});

describe('unit · the source set is every directory a package ships from', () => {
  // `collectSourceFiles(repoRoot())` walks the whole monorepo — `REPO_SCAN_TIMEOUT_MS`. WHICH
  // shard a file lands in depends on the file count, so a too-small budget presents here as an
  // intermittent failure rather than a slow test.
  //
  // `packages/*/e2e` held real source that `filesize`, `errors` and this file all walked past.
  test(
    'collectSourceFiles includes packages/*/e2e, not just src/',
    async () => {
      const paths = (await collectSourceFiles(repoRoot())).map((entry) => entry.path);
      expect(paths).toContain('packages/cli/src/bin.ts');
      expect(paths.some((path) => /^packages\/[^/]+\/e2e\//.test(path))).toBe(true);
      expect(new Set(paths).size).toBe(paths.length);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  /**
   * The other half of `errors` walks `@ultimat3/cli`'s `SOURCE_GLOBS`, which names `scripts/**`.
   * This list did not, so the 16 `X_*` codes declared here were held to the fix-line rule and not
   * to the render-safety rule — one step, two answers to "what is source". Same full-repo scan as
   * the test above.
   */
  test(
    'collectSourceFiles includes scripts/, so both halves of the errors step see it',
    async () => {
      const paths = (await collectSourceFiles(repoRoot())).map((entry) => entry.path);
      expect(paths).toContain('scripts/error-render.ts');
      expect(paths).toContain('scripts/lib/tiers.ts');
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

const FLATTENER = 'packages/admin/src/entity-columns.ts';
const REGISTRY = 'packages/admin/src/registry.ts';

describe('unit · @ultimat3/admin has one flattener', () => {
  test('a production file reading $meta or calling $describe() outside entity-columns.ts is a violation', () => {
    const violations = checkAdminFlattener([
      file('packages/admin/src/crud.ts', 'export const x = column.$meta.primaryKey;'),
      file('packages/admin/src/resource.ts', 'export const y = entity.$describe().columns;'),
    ]);
    expect(violations).toEqual([
      { file: 'packages/admin/src/crud.ts' },
      { file: 'packages/admin/src/resource.ts' },
    ]);
  });

  test('the one flattener itself is exempt', () => {
    expect(
      checkAdminFlattener([file(FLATTENER, 'export const x = column.$meta.primaryKey;')]),
    ).toEqual([]);
  });

  test('registry.ts only declares the members — that is not a read', () => {
    expect(
      checkAdminFlattener([
        file(REGISTRY, 'export interface AdminColumnMeta { readonly $meta: Foo; }'),
        file(REGISTRY, '  $describe(): AdminEntityDescription;'),
      ]),
    ).toEqual([]);
  });

  test('a test file is exempt', () => {
    expect(
      checkAdminFlattener([
        file('packages/admin/src/crud.test.ts', 'expect(column.$meta.primaryKey).toBe(true);'),
      ]),
    ).toEqual([]);
  });

  test('the violation renders as a finding with a code, a cause and a fix', () => {
    const finding = adminFlattenerFindingFor({ file: 'packages/admin/src/fields.ts' });
    expect(finding.code).toBe('X_ADMIN_FLATTENER_VIOLATION');
    expect(finding.cause).toContain('packages/admin/src/fields.ts');
    expect(finding.cause).toContain(FLATTENER);
    expect(finding.fix).toContain('entity-columns.ts');
    expect(finding.at).toBe('packages/admin/src/fields.ts');
  });

  // Same discipline as the shared/-leaf collector above: pinned against the real package rather
  // than trusted, so the rule cannot pass by pointing at an empty file list.
  test('the collector actually finds the real admin package, and it is clean today', async () => {
    const files = await collectAdminFiles(repoRoot());
    expect(files.map((entry) => entry.path)).toContain(FLATTENER);
    expect(files.map((entry) => entry.path)).toContain(REGISTRY);
    expect(checkAdminFlattener(files)).toEqual([]);
  });
});
