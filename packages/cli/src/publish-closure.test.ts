// A published package's entry points may not reach a file its tarball leaves out. Pinned on a
// tree small enough to read, and then on the real one — where the rule is either holding or the
// finding names the file to rename.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  entryFilesOf,
  fixtureReachFinding,
  fixturesReachedFrom,
  mayReachFixture,
} from './publish-closure';
import {
  checkPackageShape,
  checkPublishShape,
  FIXTURE_EXCLUSION,
  PACKAGE_FILES,
  publishesTestsFinding,
  TEST_EXCLUSION,
} from './workspace-checks';

/** A package directory as a Map: `src/index.ts` → its text. */
const tree = (files: Readonly<Record<string, string>>) => ({
  read: (path: string): string | undefined => files[path],
});

describe('unit · entryFilesOf', () => {
  test('exports and bin, as package-relative paths, each once', () => {
    const manifest = {
      exports: { '.': './src/index.ts', './serve': { import: './src/serve-entry.ts' } },
      bin: { x: './src/bin.ts' },
    };
    expect(entryFilesOf(manifest)).toEqual(['src/bin.ts', 'src/index.ts', 'src/serve-entry.ts']);
  });

  test('a string export, a string bin, and a manifest that names neither', () => {
    expect(entryFilesOf({ exports: './src/index.ts', bin: './src/index.ts' })).toEqual([
      'src/index.ts',
    ]);
    expect(entryFilesOf({})).toEqual([]);
    expect(entryFilesOf(null)).toEqual([]);
    // A subpath pattern names no one file, and a stylesheet is not a module to walk.
    expect(
      entryFilesOf({ exports: { './icons/*': './src/icons/*.ts', './t': './a.scss' } }),
    ).toEqual([]);
  });
});

describe('unit · fixturesReachedFrom', () => {
  test('a fixture the entry imports is reached, through a module in between', () => {
    const host = tree({
      'src/index.ts': "export { open } from './driver';\n",
      'src/driver.ts':
        "import { recorded } from './driver-fixture';\nexport const open = () => recorded;\n",
      'src/driver-fixture.ts': 'export const recorded = 1;\n',
    });
    expect(fixturesReachedFrom(host, ['src/index.ts'])).toEqual(['src/driver-fixture.ts']);
  });

  test('a fixture only a test imports is not reached', () => {
    const host = tree({
      'src/index.ts': "export { open } from './driver';\n",
      'src/driver.ts': 'export const open = () => 1;\n',
      'src/driver.test.ts': "import './driver-fixture';\n",
      'src/driver-fixture.ts': 'export const recorded = 1;\n',
    });
    expect(fixturesReachedFrom(host, ['src/index.ts'])).toEqual([]);
  });

  test('a type-only import reaches nothing: it is erased before the tarball is read', () => {
    const host = tree({
      'src/index.ts':
        "import type { Recorded } from './driver-fixture';\nexport type R = Recorded;\n",
      'src/driver-fixture.ts': 'export interface Recorded {}\n',
    });
    expect(fixturesReachedFrom(host, ['src/index.ts'])).toEqual([]);
  });

  test('the finding names the file, the entry and the rename', () => {
    const finding = fixtureReachFinding('scraping', 'src/driver-fixture.ts', ['src/index.ts']);
    expect(finding.code).toBe('X_PACKAGE_SHAPE');
    expect(finding.cause).toContain('packages/scraping/src/driver-fixture.ts');
    expect(finding.cause).toContain('src/index.ts');
    expect(finding.fix).toContain('packages/scraping/src/driver-fixture.ts');
    expect(finding.at).toBe('packages/scraping/src/driver-fixture.ts');
  });
});

describe('unit · mayReachFixture', () => {
  const sources = (files: Readonly<Record<string, string>>): ReadonlyMap<string, string> =>
    new Map(Object.entries(files));

  test('an entry that names a fixture, directly or through a module, may reach it', () => {
    const direct = sources({
      'src/index.ts': "export { one } from './driver-fixture';\n",
      'src/driver-fixture.ts': 'export const one = 1;\n',
    });
    expect(mayReachFixture(direct, ['src/index.ts'])).toBe(true);
    const through = sources({
      'src/index.ts': "export { open } from './drivers';\n",
      'src/drivers/index.ts': "export { one as open } from '../recorded/driver-fixture.ts';\n",
      'src/recorded/driver-fixture.ts': 'export const one = 1;\n',
    });
    expect(mayReachFixture(through, ['src/index.ts'])).toBe(true);
  });

  test('a fixture only an unreachable module names is cleared without a walk', () => {
    // `packages/cli`'s own shape: a harness module that no entry imports, importing a fixture.
    const orphan = sources({
      'src/index.ts': "export { run } from './run';\n",
      'src/run.ts': 'export const run = 1;\n',
      'src/harness.ts': "import { tree } from './scaffold-fixture';\nexport const t = tree;\n",
      'src/scaffold-fixture.ts': 'export const tree = 1;\n',
    });
    expect(mayReachFixture(orphan, ['src/index.ts'])).toBe(false);
    // And a fixture importing another fixture is two fixtures, not a way in.
    const pair = sources({
      'src/index.ts': 'export const run = 1;\n',
      'src/a-fixture.ts': "import './b-fixture';\n",
      'src/b-fixture.ts': 'export const b = 1;\n',
    });
    expect(mayReachFixture(pair, ['src/index.ts'])).toBe(false);
  });
});

describe('a published package whose entry reaches a fixture', () => {
  // The rule's other half, through `checkPackageShape` — a rule nothing calls is not a rule. The
  // exclusion is in `files`, so the tarball leaves `driver-fixture.ts` out while `index.ts` still
  // imports it: a package that publishes green and fails on its first import.
  test('is a package-shape finding naming the file to rename; a private one is exempt', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'ultimate-fixture-reach-'));
    try {
      for (const file of PACKAGE_FILES) await Bun.write(join(bad, 'packages/p', file), '{}\n');
      const manifest = (extra: string): string =>
        `{"name":"p","version":"1.0.0",${extra}"exports":{".":"./src/index.ts"},"files":["src","${TEST_EXCLUSION}","${FIXTURE_EXCLUSION}"]}\n`;
      await Bun.write(
        join(bad, 'tsconfig.json'),
        '{"files":[],"references":[{"path":"packages/p"}]}\n',
      );
      await Bun.write(join(bad, 'packages/p/package.json'), manifest(''));
      await Bun.write(
        join(bad, 'packages/p/src/index.ts'),
        "export { one } from './driver-fixture';\n",
      );
      await Bun.write(join(bad, 'packages/p/src/driver-fixture.ts'), 'export const one = 1;\n');
      const at = (findings: readonly { at?: string }[]): readonly (string | undefined)[] =>
        findings.map((finding) => finding.at);
      expect(at(await checkPackageShape(bad))).toContain('packages/p/src/driver-fixture.ts');
      // The same fixture, imported by a test alone: nothing a consumer can load reaches it.
      await Bun.write(join(bad, 'packages/p/src/index.ts'), 'export const two = 2;\n');
      await Bun.write(join(bad, 'packages/p/src/index.test.ts'), "import './driver-fixture';\n");
      expect(at(await checkPackageShape(bad))).not.toContain('packages/p/src/driver-fixture.ts');
      // A generated app's packages are private: no tarball, nothing to leave out of one.
      await Bun.write(
        join(bad, 'packages/p/src/index.ts'),
        "export { one } from './driver-fixture';\n",
      );
      await Bun.write(join(bad, 'packages/p/package.json'), manifest('"private":true,'));
      expect(at(await checkPackageShape(bad))).not.toContain('packages/p/src/driver-fixture.ts');
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe('unit · a fixture is excluded from files as a test is', () => {
  // A `-fixture.ts` is test code under another suffix: six packages shipped theirs — 18 files —
  // because only `*.test.ts` was held. Each exclusion is its own finding, naming its own entry.
  test('a published package that excludes its tests and not its fixtures is a finding', () => {
    const manifest = {
      dir: 'short',
      name: '@ultimat3/short',
      version: '1.0.0',
      private: false,
      frameworkDeps: [],
      // No literal entry: only a literal is existence-checked, and this root holds nothing.
      files: [TEST_EXCLUSION, 'src/**/*.ts'],
    };
    expect(checkPublishShape('/nowhere', [manifest])).toEqual([
      publishesTestsFinding('short', FIXTURE_EXCLUSION),
    ]);
    expect(publishesTestsFinding('short', FIXTURE_EXCLUSION).fix).toContain(FIXTURE_EXCLUSION);
  });
});
