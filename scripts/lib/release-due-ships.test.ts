// What counts as shipping for `scripts/release-due.ts`: a path npm packs into a published tarball,
// read off each package's own `files` — never root tooling, docs, tests or fixtures.

import { describe, expect, test } from 'bun:test';
import type { PackageFiles } from './release-due-ships';
import { inTarball, packageFiles, shippingPackage } from './release-due-ships';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';
import { listWorkspaces, publishOrder } from './workspaces';

/** The `files` field every package in this tree declares, `cli` adding `types`. */
const FILES = ['src', '!src/**/*.test.ts', '!src/**/*-fixture.ts', 'CLAUDE.md', 'README.md'];
const PACKAGES: ReadonlyMap<string, PackageFiles> = new Map([
  ['core', { dir: 'core', files: FILES }],
  ['cli', { dir: 'cli', files: [...FILES, 'types'] }],
  ['create-ultimate', { dir: 'create-ultimate', files: FILES }],
  ['loose', { dir: 'loose', files: undefined }],
]);

describe('unit · release-due-ships · the files field, read as npm reads it', () => {
  test('an include matches a directory, a file in it, or a glob', () => {
    expect(inTarball('src/a.ts', FILES)).toBe(true);
    expect(inTarball('src/deep/a.ts', FILES)).toBe(true);
    expect(inTarball('README.md', FILES)).toBe(true);
    expect(inTarball('tsconfig.json', FILES)).toBe(false);
    expect(inTarball('e2e/a.ts', FILES)).toBe(false);
  });

  test('a negation removes what an include matched, at any depth', () => {
    expect(inTarball('src/a.test.ts', FILES)).toBe(false);
    expect(inTarball('src/deep/a.test.ts', FILES)).toBe(false);
    expect(inTarball('src/deep/a-fixture.ts', FILES)).toBe(false);
  });

  test('no files field packs everything', () => {
    expect(inTarball('anything/at/all.ts', undefined)).toBe(true);
  });
});

describe('unit · release-due-ships · what ships', () => {
  test('source, a declared extra directory and package.json ship, create-ultimate included', () => {
    expect(shippingPackage('packages/core/src/errors.ts', PACKAGES)).toBe('core');
    expect(shippingPackage('packages/cli/types/x.d.ts', PACKAGES)).toBe('cli');
    expect(shippingPackage('packages/core/package.json', PACKAGES)).toBe('core');
    expect(shippingPackage('packages/create-ultimate/src/index.ts', PACKAGES)).toBe(
      'create-ultimate',
    );
  });

  test('prose, tests and fixtures do not, though npm packs a README', () => {
    for (const path of [
      'packages/core/README.md',
      'packages/core/CLAUDE.md',
      'packages/core/src/errors.test.ts',
      'packages/core/src/view.test.tsx',
      'packages/core/src/seed-fixture.ts',
      'packages/core/src/fixtures/app.ts',
      'packages/loose/fixtures/app.ts',
    ]) {
      expect({ path, ships: shippingPackage(path, PACKAGES) }).toEqual({ path, ships: undefined });
    }
  });

  test('root tooling, docs, apps, unpacked package files and unknown packages do not', () => {
    for (const path of [
      'package.json',
      'bun.lock',
      '.github/workflows/ci.yml',
      'docker/Dockerfile',
      'docs/idea/README.md',
      'wiki/Home.md',
      'examples/dummy/package.json',
      'dummy/social-media-clone/apps/web/app/page.tsx',
      'scripts/release.ts',
      'packages/core/tsconfig.json',
      'packages/private-thing/src/a.ts',
    ]) {
      expect({ path, ships: shippingPackage(path, PACKAGES) }).toEqual({ path, ships: undefined });
    }
  });

  test(
    'the real tree: every publishable package declares files, and its source ships',
    async () => {
      const publishable = publishOrder(await listWorkspaces(repoRoot()));
      const real = await packageFiles(publishable);
      expect(real.size).toBe(publishable.length);
      expect(shippingPackage('packages/core/src/errors.ts', real)).toBe('core');
      expect(shippingPackage('packages/core/src/errors.test.ts', real)).toBeUndefined();
      for (const pkg of real.values())
        expect({ dir: pkg.dir, has: pkg.files !== undefined }).toEqual({
          dir: pkg.dir,
          has: true,
        });
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
