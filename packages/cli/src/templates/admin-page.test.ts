// What `x g admin:page` has to get right: no `defineRoute` (the frame's `pages:` is the one way
// in), a guarded declaration, and a destination the caller can name. Failure case first — the
// hardcoded directory, which sent every app whose admin is not `apps/admin/src/pages` to `git mv`.

import { describe, expect, test } from 'bun:test';
import { adminPageFiles, DEFAULT_ADMIN_PAGE_DIR } from './admin-page';

const paths = (files: readonly { path: string }[]): readonly string[] =>
  files.map((file) => file.path);

describe('x g admin:page', () => {
  test('--at decides the directory, exactly as it does for x g island', () => {
    const files = adminPageFiles('ops', {
      permission: 'ops:read',
      dir: 'apps/admin/app/admin',
    });
    expect(paths(files)).toContain('apps/admin/app/admin/ops.tsx');
    expect(paths(files)).toContain('apps/admin/app/admin/ops.test.ts');
    expect(paths(files).some((path) => path.startsWith(DEFAULT_ADMIN_PAGE_DIR))).toBe(false);
  });

  test('a trailing slash is not a second directory', () => {
    const files = adminPageFiles('ops', { permission: 'ops:read', dir: 'apps/admin/app/admin/' });
    expect(paths(files)).toContain('apps/admin/app/admin/ops.tsx');
  });

  test('no --at keeps the layout x new scaffolds', () => {
    const files = adminPageFiles('reconcile', { permission: 'ledger:reconcile' });
    expect(paths(files)).toContain(`${DEFAULT_ADMIN_PAGE_DIR}/reconcile.tsx`);
  });

  /**
   * The reported defect: `x g admin:page ops` emitted `permissions: ['ops:read']` and nothing
   * anywhere declared `ops:read`, so `assertPermission` threw X_PERMISSION_UNKNOWN on the first
   * request that reached the page — a screen the generator built and nobody can open. The gate
   * could not see it either: the `policy` step reads `routeEntries()`, and an admin page is not a
   * route. So the page declares what it requires, in the file that requires it.
   */
  test('the page declares the permission it requires, at runtime and in the type', () => {
    const files = adminPageFiles('ops', { permission: 'ops:read' });
    const page = files.find((file) => file.path.endsWith('ops.tsx'));
    expect(page?.contents).toContain("definePermissions(['ops:read'])");
    expect(page?.contents).toContain("'ops:read': true;");
    expect(page?.contents).toContain("declare module '@ultimat3/policy'");
  });

  test('and its emitted test fails if that declaration is ever dropped', () => {
    const files = adminPageFiles('ops', { permission: 'ops:read' });
    const spec = files.find((file) => file.path.endsWith('ops.test.ts'));
    expect(spec?.contents).toContain('knownPermissions()');
    expect(spec?.contents).toContain("'ops:read'");
  });

  test('the generator writes no manifest and no route declaration', () => {
    const files = adminPageFiles('ops', { permission: 'ops:read', dir: 'apps/admin/app/admin' });
    // A generator that emits a committed contract as a side effect of scaffolding a page is a
    // generator inventing a file the app never had.
    expect(paths(files).some((path) => path.endsWith('x.manifest.json'))).toBe(false);
    const page = files.find((file) => file.path.endsWith('ops.tsx'));
    expect(page?.contents).not.toContain('defineRoute(');
    expect(page?.contents).toContain("permissions: ['ops:read']");
    // The wire-in hint names where the file actually landed, not the scaffold's layout.
    expect(page?.contents).toContain('apps/admin/app/admin/ops.tsx');
  });
});
