// `x g app <name>` / `x g package <name>`'s files: a workspace the root `workspaces` globs and the
// root tsconfig's one alias already cover, and the contract files `package-shape` requires.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { repoFiles } from './scaffold-repo';
import { workspaceAppFiles, workspacePackageFiles } from './workspace';

const app = names('mono');
const byPath = (files: ReturnType<typeof workspaceAppFiles>) =>
  new Map(files.map((file) => [file.path, file]));

describe('unit · x g app <name>', () => {
  const files = byPath(workspaceAppFiles(app, 'api'));

  test('writes a workspace under apps/ named into the app scope, depending on nothing', () => {
    const manifest = JSON.parse(String(files.get('apps/api/package.json')?.contents));
    expect(manifest.name).toBe('@mono/api');
    expect(manifest.private).toBe(true);
    // An app reaches packages by declaring them as it imports them (`X_WORKSPACE_DEP_UNDECLARED`);
    // a fresh one imports nothing, so it declares nothing — and never a sibling app.
    expect(manifest.dependencies).toBeUndefined();
    expect(files.get('apps/api/tsconfig.json')?.contents).toContain('"../../tsconfig.json"');
  });

  test('is the shape apps/admin already has, and nothing more', () => {
    expect([...files.keys()].sort()).toEqual(['apps/api/package.json', 'apps/api/tsconfig.json']);
  });
});

describe('unit · x g package <name>', () => {
  const files = byPath(workspacePackageFiles(app, 'billing'));

  test('writes every file package-shape requires, and a tested index', () => {
    expect([...files.keys()].sort()).toEqual([
      'packages/billing/CLAUDE.md',
      'packages/billing/README.md',
      'packages/billing/package.json',
      'packages/billing/src/index.test.ts',
      'packages/billing/src/index.ts',
      'packages/billing/tsconfig.json',
    ]);
    expect(JSON.parse(String(files.get('packages/billing/package.json')?.contents)).name).toBe(
      '@mono/billing',
    );
  });

  test('its CLAUDE.md states the boundary the gate enforces: never an app', () => {
    expect(files.get('packages/billing/CLAUDE.md')?.contents).toContain('never a sibling app');
  });

  test('touches nothing outside its own directory', () => {
    expect([...files.keys()].every((path) => path.startsWith('packages/billing/'))).toBe(true);
  });
});

describe('unit · the scaffold reaches every workspace through one alias', () => {
  test('@<app>/* tries packages/*/src, then apps/* — no per-app line for x g app to add', () => {
    const tsconfig = repoFiles(app, '0.0.0', true).find((file) => file.path === 'tsconfig.json');
    expect(JSON.parse(String(tsconfig?.contents)).compilerOptions.paths).toEqual({
      '@mono/*': ['./packages/*/src', './apps/*'],
    });
  });
});
