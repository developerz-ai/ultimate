// The two single-owner rules beside the tier table: an app's shared/ imports nothing of app/, and
// @ultimat3/admin flattens entity metadata in one file; plus the source set the scan reads.
// Split from boundaries.test.ts, which keeps the import rules themselves.

import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './boundaries';
import {
  adminFlattenerFindingFor,
  checkAdminFlattener,
  checkSharedLeaf,
  collectAdminFiles,
  collectSharedFiles,
  collectSourceFiles,
  resolveSpecifier,
  sharedLeafFindingFor,
  surfaceOf,
} from './boundaries';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const file = (path: string, source: string): SourceFile => ({ path, source });

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

  // Finding 11, 2026-09-06: the glob was `**/*.ts`, and `@ultimat3/admin` is a component package —
  // seven of its modules are `.tsx`, including every screen that renders a column. The rule read
  // none of them, so the file most likely to flatten an entity onto `AdminColumnFacts` was the one
  // file class it could not see.
  test('and it reads the .tsx half of the package, which is where the screens are', async () => {
    const files = await collectAdminFiles(repoRoot());
    expect(files.map((entry) => entry.path)).toContain('packages/admin/src/list.tsx');
    expect(files.filter((entry) => entry.path.endsWith('.tsx')).length).toBeGreaterThan(4);
  });
});
