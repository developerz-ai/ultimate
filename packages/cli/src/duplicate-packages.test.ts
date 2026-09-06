// Failure first: an app whose `packages/i18n` workspace resolves a DIFFERENT `@ultimat3/i18n` than
// its root — the shape that answered `X_CATALOG_UNREGISTERED` with a fix naming an edit that had
// already been made. Then the shapes that must NOT be reported: a workspace symlink to one checkout.

import { describe, expect, test } from 'bun:test';
// why: a fixture with a real symlink is the only proof that the realpath dedupe reads the filesystem.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
// why: Bun ships no temp-directory primitive.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  CLI_ORIGIN,
  type DuplicateInstall,
  type DuplicateIo,
  duplicateCause,
  duplicateFinding,
  duplicateFix,
  duplicateInstalls,
  findDuplicateInstalls,
  installedCopies,
  REGISTRY_PACKAGES,
} from './duplicate-packages';

const copy = (from: string, dir: string, version: string, pkg = '@ultimat3/i18n') => ({
  pkg,
  from,
  dir,
  version,
});

describe('unit · duplicateInstalls — the pure classifier', () => {
  test('one real directory, however many origins resolve to it, is no duplicate', () => {
    expect(
      duplicateInstalls([
        copy('.', '/app/node_modules/@ultimat3/i18n', '19.1.0'),
        copy('packages/i18n', '/app/node_modules/@ultimat3/i18n', '19.1.0'),
        copy(CLI_ORIGIN, '/app/node_modules/@ultimat3/i18n', '19.1.0'),
      ]),
    ).toEqual([]);
  });

  test('two real directories at two versions is one duplicate, newest first', () => {
    const found = duplicateInstalls([
      copy(
        '.',
        '/app/node_modules/.bun/@ultimat3+i18n@19.1.0/node_modules/@ultimat3/i18n',
        '19.1.0',
      ),
      copy(
        'packages/i18n',
        '/app/node_modules/.bun/@ultimat3+i18n@19.0.0/node_modules/@ultimat3/i18n',
        '19.0.0',
      ),
      copy(
        CLI_ORIGIN,
        '/app/node_modules/.bun/@ultimat3+i18n@19.1.0/node_modules/@ultimat3/i18n',
        '19.1.0',
      ),
    ]);
    expect(found).toEqual([
      {
        pkg: '@ultimat3/i18n',
        copies: [
          {
            dir: '/app/node_modules/.bun/@ultimat3+i18n@19.1.0/node_modules/@ultimat3/i18n',
            version: '19.1.0',
            from: ['.', CLI_ORIGIN],
          },
          {
            dir: '/app/node_modules/.bun/@ultimat3+i18n@19.0.0/node_modules/@ultimat3/i18n',
            version: '19.0.0',
            from: ['packages/i18n'],
          },
        ],
      },
    ]);
  });

  test('two real directories at ONE version are still two registries, still a duplicate', () => {
    const found = duplicateInstalls([
      copy('.', '/app/node_modules/@ultimat3/i18n', '19.1.0'),
      copy('apps/web', '/app/apps/web/node_modules/@ultimat3/i18n', '19.1.0'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.copies.map((entry) => entry.dir)).toEqual([
      '/app/apps/web/node_modules/@ultimat3/i18n',
      '/app/node_modules/@ultimat3/i18n',
    ]);
  });

  test('packages are judged apart and reported in name order; versions compare numerically', () => {
    const found = duplicateInstalls([
      copy('.', '/a/policy-new', '19.10.0', '@ultimat3/policy'),
      copy('apps/web', '/a/policy-old', '19.9.0', '@ultimat3/policy'),
      copy('.', '/a/entity', '19.1.0', '@ultimat3/entity'),
      copy('apps/web', '/a/entity', '19.1.0', '@ultimat3/entity'),
      copy('.', '/a/i18n', '19.1.0'),
      copy('apps/web', '/a/i18n-pre', '19.1.0-beta.1'),
    ]);
    expect(found.map((duplicate) => duplicate.pkg)).toEqual(['@ultimat3/i18n', '@ultimat3/policy']);
    expect(found[1]?.copies.map((entry) => entry.version)).toEqual(['19.10.0', '19.9.0']);
    expect(found[0]?.copies.map((entry) => entry.version)).toEqual(['19.1.0', '19.1.0-beta.1']);
  });
});

const TWO_VERSIONS: DuplicateInstall = {
  pkg: '@ultimat3/i18n',
  copies: [
    {
      dir: '/app/node_modules/.bun/@ultimat3+i18n@19.1.0/node_modules/@ultimat3/i18n',
      version: '19.1.0',
      from: ['.', CLI_ORIGIN],
    },
    {
      dir: '/app/node_modules/.bun/@ultimat3+i18n@19.0.0/node_modules/@ultimat3/i18n',
      version: '19.0.0',
      from: ['packages/i18n'],
    },
  ],
};

const ONE_VERSION: DuplicateInstall = {
  pkg: '@ultimat3/policy',
  copies: [
    { dir: '/app/node_modules/@ultimat3/policy', version: '19.1.0', from: ['.'] },
    { dir: '/app/apps/web/node_modules/@ultimat3/policy', version: '19.1.0', from: ['apps/web'] },
  ],
};

describe('unit · the finding', () => {
  test('the cause names both copies, app-relative, and the registry each one holds', () => {
    const cause = duplicateCause('/app', TWO_VERSIONS);
    expect(cause).toContain('2 copies of @ultimat3/i18n are installed');
    expect(cause).toContain(
      'node_modules/.bun/@ultimat3+i18n@19.1.0/node_modules/@ultimat3/i18n@19.1.0 (resolved from ., the x CLI)',
    );
    expect(cause).toContain(
      'node_modules/.bun/@ultimat3+i18n@19.0.0/node_modules/@ultimat3/i18n@19.0.0 (resolved from packages/i18n)',
    );
    expect(cause).toContain(REGISTRY_PACKAGES['@ultimat3/i18n'] ?? '');
    expect(cause).not.toContain('defineCatalogs');
  });

  test('a copy outside the app root keeps its absolute path', () => {
    const cause = duplicateCause('/elsewhere', TWO_VERSIONS);
    expect(cause).toContain('/app/node_modules/.bun/@ultimat3+i18n@19.0.0');
  });

  test('two versions: the fix pins the newest in the manifest that resolves the older', () => {
    expect(duplicateFix(TWO_VERSIONS, 'x i18n check --json')).toBe(
      'set "@ultimat3/i18n": "19.1.0" in packages/i18n/package.json, then: bun install && x i18n check --json',
    );
  });

  test('two versions, the older read only by the CLI: no manifest to name, every pin instead', () => {
    const cliOld: DuplicateInstall = {
      pkg: '@ultimat3/entity',
      copies: [
        { dir: '/app/new', version: '19.1.0', from: ['.'] },
        { dir: '/app/old', version: '19.0.0', from: [CLI_ORIGIN] },
      ],
    };
    expect(duplicateFix(cliOld, 'x verify --json')).toBe(
      'set "@ultimat3/entity": "19.1.0" in every package.json that pins it, then: bun install && x verify --json',
    );
  });

  test('one version twice: the fix is the install, because no manifest edit can collapse it', () => {
    expect(duplicateFix(ONE_VERSION, 'x verify --only policy --json')).toBe(
      'bun install --force   # one resolution of @ultimat3/policy for every workspace; then: x verify --only policy --json',
    );
  });

  test('the finding is X_PACKAGE_DUPLICATED, located at the first manifest that resolves a copy', () => {
    const finding = duplicateFinding('/app', TWO_VERSIONS, 'x i18n check --json');
    expect(finding.code).toBe('X_PACKAGE_DUPLICATED');
    expect(finding.at).toBe('package.json');
    expect(finding.docs).toBeDefined();
    expect(duplicateFinding('/app', ONE_VERSION, 'x').at).toBe('package.json');
    // A duplicate read only by the CLI has no manifest to point at, and none is invented.
    const cliOnly: DuplicateInstall = {
      pkg: '@ultimat3/entity',
      copies: [
        { dir: '/a', version: '19.1.0', from: [CLI_ORIGIN] },
        { dir: '/b', version: '19.0.0', from: [CLI_ORIGIN] },
      ],
    };
    expect(duplicateFinding('/app', cliOnly, 'x').at).toBeUndefined();
  });
});

/**
 * A fixture install: a root copy, a workspace whose own `node_modules` holds a second copy, a
 * workspace that resolves the root's through a symlink, and a workspace with no copy at all.
 */
function fixture(): { root: string; cli: string } {
  const root = mkdtempSync(join(tmpdir(), 'x-duplicate-packages-'));
  const manifest = (dir: string, name: string, version: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
  };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', workspaces: ['apps/*', 'packages/*'] }),
  );
  manifest(join(root, 'node_modules/@ultimat3/i18n'), '@ultimat3/i18n', '19.1.0');
  manifest(join(root, 'node_modules/@ultimat3/policy'), '@ultimat3/policy', '19.1.0');
  // The workspace that pinned the older range and got its own copy.
  mkdirSync(join(root, 'packages/i18n'), { recursive: true });
  writeFileSync(join(root, 'packages/i18n/package.json'), JSON.stringify({ name: '@app/i18n' }));
  manifest(join(root, 'packages/i18n/node_modules/@ultimat3/i18n'), '@ultimat3/i18n', '19.0.0');
  // The workspace whose `node_modules` entry is a SYMLINK to the root's — one instance, not two.
  mkdirSync(join(root, 'apps/web/node_modules/@ultimat3'), { recursive: true });
  writeFileSync(join(root, 'apps/web/package.json'), JSON.stringify({ name: '@app/web' }));
  symlinkSync(
    join(root, 'node_modules/@ultimat3/i18n'),
    join(root, 'apps/web/node_modules/@ultimat3/i18n'),
  );
  // A workspace with nothing of its own resolves the root's, exactly as a hoisted install does.
  mkdirSync(join(root, 'packages/db'), { recursive: true });
  writeFileSync(join(root, 'packages/db/package.json'), JSON.stringify({ name: '@app/db' }));
  // The CLI sits under a store entry whose sibling scope holds the SAME root policy through a link.
  const cli = join(root, 'node_modules/.bun/@ultimat3+cli@19.1.0/node_modules/@ultimat3/cli/src');
  mkdirSync(join(root, 'node_modules/.bun/@ultimat3+cli@19.1.0/node_modules/@ultimat3'), {
    recursive: true,
  });
  mkdirSync(cli, { recursive: true });
  symlinkSync(
    join(root, 'node_modules/@ultimat3/i18n'),
    join(root, 'node_modules/.bun/@ultimat3+cli@19.1.0/node_modules/@ultimat3/i18n'),
  );
  return { root, cli };
}

describe('integration · installedCopies over a real fixture tree', () => {
  test('a nested copy is found, a symlink is the same copy, an absent one contributes nothing', async () => {
    const { root, cli } = fixture();
    const copies = await installedCopies(
      root,
      ['@ultimat3/i18n', '@ultimat3/policy'],
      undefined,
      cli,
    );
    const i18n = copies.filter((entry) => entry.pkg === '@ultimat3/i18n');
    // Root, packages/i18n (its own copy), apps/web (a symlink to the root's), the CLI (a symlink
    // too); packages/db has nothing and Bun does not resolve upward from a fixture with no parent
    // `node_modules` beyond the root's — which it DOES find, so it resolves the root's.
    expect(i18n.map((entry) => entry.from).sort()).toEqual(
      ['.', 'apps/web', 'packages/db', 'packages/i18n', CLI_ORIGIN].sort(),
    );
    const found = duplicateInstalls(copies);
    expect(found.map((duplicate) => duplicate.pkg)).toEqual(['@ultimat3/i18n']);
    expect(found[0]?.copies.map((entry) => [entry.version, entry.from])).toEqual([
      ['19.1.0', ['.', 'apps/web', 'packages/db', CLI_ORIGIN]],
      ['19.0.0', ['packages/i18n']],
    ]);
    // `@ultimat3/policy` resolves from every origin to one real directory: not a duplicate.
    const policy = copies.filter((entry) => entry.pkg === '@ultimat3/policy');
    expect(new Set(policy.map((entry) => entry.dir)).size).toBe(1);
  });

  test('findDuplicateInstalls composes the two halves', async () => {
    const { root } = fixture();
    // The real CLI directory of this checkout resolves this monorepo's `packages/i18n` — a third
    // real directory, so the composed call reports the fixture's two plus that one.
    const found = await findDuplicateInstalls(root, ['@ultimat3/i18n']);
    expect(found).toHaveLength(1);
    expect(found[0]?.copies.length).toBeGreaterThanOrEqual(2);
  });

  test('a manifest that names another package, or will not parse, is not a copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-duplicate-packages-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', workspaces: [] }));
    const io: DuplicateIo = {
      resolve: (specifier, from) =>
        from === root ? `${root}/node_modules/${specifier}/index.js` : `${root}/cli/index.js`,
      realpath: (path) => path,
      exists: (path) => path.endsWith('package.json'),
      readText: (path) =>
        path.includes('node_modules') ? '{ not json' : JSON.stringify({ name: 'something-else' }),
    };
    expect(await installedCopies(root, ['@ultimat3/i18n'], io, `${root}/cli`)).toEqual([]);
  });

  test('an entry six directories below any manifest, or at the filesystem root, is not a copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-duplicate-packages-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', workspaces: [] }));
    const io: DuplicateIo = {
      resolve: (_specifier, from) => (from === root ? '/a/b/c/d/e/f/g/h/index.js' : '/index.js'),
      realpath: (path) => path,
      exists: () => false,
      readText: () => '',
    };
    expect(await installedCopies(root, ['@ultimat3/i18n'], io, `${root}/cli`)).toEqual([]);
    // A manifest with no `version` reports `0.0.0`, and a non-object manifest is skipped.
    const versionless: DuplicateIo = {
      resolve: () => `${root}/node_modules/@ultimat3/i18n/index.js`,
      realpath: (path) => path,
      exists: (path) => path.endsWith('package.json'),
      readText: (path) =>
        path.includes('cli') ? 'null' : JSON.stringify({ name: '@ultimat3/i18n' }),
    };
    const copies = await installedCopies(root, ['@ultimat3/i18n'], versionless, `${root}/cli`);
    expect(copies.map((entry) => entry.version)).toEqual(['0.0.0', '0.0.0']);
  });
});

describe('integration · this checkout', () => {
  test('the reference app, whose node_modules symlink to packages/, has no duplicate', async () => {
    const checkout = join(import.meta.dir, '..', '..', '..');
    const dummy = join(checkout, 'examples', 'dummy');
    expect(await findDuplicateInstalls(dummy, Object.keys(REGISTRY_PACKAGES))).toEqual([]);
  });
});
