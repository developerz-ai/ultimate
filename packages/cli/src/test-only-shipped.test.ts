import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { fixProblem } from './error-contract';
import type { ShippedPackage } from './test-only-shipped';
import { entryPatternsOf, testOnlyModules, testOnlyShippedFinding } from './test-only-shipped';
import {
  checkPackageShape,
  FIXTURE_EXCLUSION,
  PACKAGE_FILES,
  TEST_EXCLUSION,
} from './workspace-checks';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

const P: readonly ShippedPackage[] = [{ dir: 'p', entries: ['src/index.ts'] }];

const tree = (files: Readonly<Record<string, string>>): ReadonlyMap<string, string> =>
  new Map(Object.entries(files));

const paths = (sources: ReadonlyMap<string, string>, packages = P): readonly string[] =>
  testOnlyModules(sources, packages).map((module) => module.path);

describe('testOnlyModules', () => {
  test('a module only tests import is test-only; one the package imports is not', () => {
    const sources = tree({
      'packages/p/src/index.ts': "export { real } from './real';\n",
      'packages/p/src/real.ts': 'export const real = 1;\n',
      'packages/p/src/fake.ts': 'export const fake = 1;\n',
      'packages/p/src/real.test.ts':
        "import { real } from './real';\nimport { fake } from './fake';\n",
    });
    expect(paths(sources)).toEqual(['packages/p/src/fake.ts']);
  });

  test('every importer counts: a type import, a re-export, a dynamic import, a bare import', () => {
    for (const line of [
      "import type { Fake } from './fake';",
      "export { fake } from './fake';",
      "const load = () => import('./fake');",
      "import './fake';",
    ]) {
      const sources = tree({
        'packages/p/src/index.ts': `${line}\n`,
        'packages/p/src/fake.ts': 'export const fake = 1;\n',
        'packages/p/src/fake.test.ts': "import { fake } from './fake';\n",
      });
      expect(paths(sources)).toEqual([]);
    }
  });

  test('an import inside a comment is not an importer', () => {
    const sources = tree({
      'packages/p/src/index.ts': "// import { fake } from './fake';\nexport const x = 1;\n",
      'packages/p/src/fake.ts': 'export const fake = 1;\n',
      'packages/p/src/fake.test.ts': "import { fake } from './fake';\n",
    });
    expect(paths(sources)).toEqual(['packages/p/src/fake.ts']);
  });

  // A helper only a fake imports ships for the fake's sake, and is test code by the same token.
  test('test-only is transitive through fixtures and through other test-only modules', () => {
    const sources = tree({
      'packages/p/src/index.ts': 'export const x = 1;\n',
      'packages/p/src/fake.ts': "import { html } from './fake-html';\nexport const fake = html;\n",
      'packages/p/src/fake-html.ts': 'export const html = 1;\n',
      'packages/p/src/rig-fixture.ts': "import { util } from './util';\nexport const rig = util;\n",
      'packages/p/src/util.ts': 'export const util = 1;\n',
      'packages/p/src/a.test.ts':
        "import { fake } from './fake';\nimport { rig } from './rig-fixture';\n",
    });
    expect(paths(sources)).toEqual([
      'packages/p/src/fake-html.ts',
      'packages/p/src/fake.ts',
      'packages/p/src/util.ts',
    ]);
  });

  test('a module a shipped file names by path (a spawned probe, a worker) is not test-only', () => {
    const sources = tree({
      'packages/p/src/index.ts':
        "const PROBE = join(import.meta.dir, 'probe.ts');\nconst w = new URL('./worker.ts', import.meta.url);\n",
      'packages/p/src/probe.ts': 'export const probe = 1;\n',
      'packages/p/src/worker.ts': 'export const worker = 1;\n',
      'packages/p/src/a.test.ts':
        "import { probe } from './probe';\nimport { worker } from './worker';\n",
    });
    expect(paths(sources)).toEqual([]);
  });

  test('an entry point, a fixture, a test and a module nobody imports are never reported', () => {
    const sources = tree({
      'packages/p/src/index.ts': 'export const x = 1;\n',
      'packages/p/src/glyphs/star.ts': 'export const star = 1;\n',
      'packages/p/src/rig-fixture.ts': 'export const rig = 1;\n',
      'packages/p/src/helper.test.ts': 'export const h = 1;\n',
      'packages/p/src/orphan.ts': 'export const orphan = 1;\n',
      'packages/p/src/a.test.ts':
        "import { x } from './index';\nimport { star } from './glyphs/star';\nimport { rig } from './rig-fixture';\nimport { h } from './helper.test';\n",
    });
    const packages = [{ dir: 'p', entries: ['src/index.ts', 'src/glyphs/*.ts'] }];
    expect(paths(sources, packages)).toEqual([]);
  });

  test('a shipped importer anywhere in the repo counts — a script, another package', () => {
    const sources = tree({
      'packages/p/src/index.ts': 'export const x = 1;\n',
      'packages/p/src/tool.ts': 'export const tool = 1;\n',
      'packages/p/src/tool.test.ts': "import { tool } from './tool';\n",
      'scripts/use-tool.ts': "import { tool } from '../packages/p/src/tool';\n",
    });
    expect(paths(sources)).toEqual([]);
    // and a test elsewhere is still a test
    const onlyTests = new Map(sources);
    onlyTests.set('scripts/use-tool.test.ts', onlyTests.get('scripts/use-tool.ts') ?? '');
    onlyTests.delete('scripts/use-tool.ts');
    expect(paths(onlyTests)).toEqual(['packages/p/src/tool.ts']);
  });

  test('only the listed (published) packages are judged', () => {
    const sources = tree({
      'packages/q/src/fake.ts': 'export const fake = 1;\n',
      'packages/q/src/fake.test.ts': "import { fake } from './fake';\n",
    });
    expect(paths(sources)).toEqual([]);
  });

  test('importers are reported, sorted', () => {
    const sources = tree({
      'packages/p/src/fake.ts': 'export const fake = 1;\n',
      'packages/p/src/z.test.ts': "import { fake } from './fake';\n",
      'packages/p/src/a.test.ts': "import { fake } from './fake';\n",
    });
    expect(testOnlyModules(sources, P)[0]?.importers).toEqual([
      'packages/p/src/a.test.ts',
      'packages/p/src/z.test.ts',
    ]);
  });
});

describe('entryPatternsOf', () => {
  test('exports, bin, browser and package scripts all name entries', () => {
    expect(
      entryPatternsOf({
        exports: { '.': './src/index.ts', './icons/*': './src/icons/glyphs/*.ts' },
        bin: { x: './src/bin.ts' },
        browser: { './src/a.ts': './src/a.browser.ts' },
        scripts: { icons: 'bun run src/icons/build-icons.ts' },
      }),
    ).toEqual([
      'src/a.browser.ts',
      'src/a.ts',
      'src/bin.ts',
      'src/icons/build-icons.ts',
      'src/icons/glyphs/*.ts',
      'src/index.ts',
    ]);
  });
});

describe('testOnlyShippedFinding', () => {
  test('the fix is the registered rename, concrete and runnable', () => {
    const finding = testOnlyShippedFinding({
      path: 'packages/db/src/fake-pglite.ts',
      importers: ['packages/db/src/a.test.ts'],
    });
    expect(finding.code).toBe('X_PACKAGE_TEST_ONLY_SHIPPED');
    expect(finding.at).toBe('packages/db/src/fake-pglite.ts');
    expect(finding.fix).toBe(
      'git mv packages/db/src/fake-pglite.ts packages/db/src/fake-pglite-fixture.ts   # and update its importers',
    );
    expect(finding.cause).toContain('packages/db/src/a.test.ts');
    expect(fixProblem(finding.fix)).toBeUndefined();
  });
});

describe('integration · package-shape', () => {
  test('checkPackageShape reports a test-only module of a published package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-test-only-'));
    try {
      for (const file of PACKAGE_FILES) await Bun.write(join(root, 'packages/p', file), '{}\n');
      const manifest = (extra: string): string =>
        `{"name":"p","version":"1.0.0",${extra}"exports":{".":"./src/index.ts"},"files":["src","${TEST_EXCLUSION}","${FIXTURE_EXCLUSION}"]}\n`;
      await Bun.write(join(root, 'packages/p/package.json'), manifest(''));
      await Bun.write(join(root, 'packages/p/src/index.ts'), 'export const x = 1;\n');
      await Bun.write(join(root, 'packages/p/src/fake.ts'), 'export const fake = 1;\n');
      await Bun.write(
        join(root, 'packages/p/src/fake.test.ts'),
        "import { fake } from './fake';\n",
      );
      const found = (await checkPackageShape(root)).filter(
        (finding) => finding.code === 'X_PACKAGE_TEST_ONLY_SHIPPED',
      );
      expect(found.map((finding) => finding.at)).toEqual(['packages/p/src/fake.ts']);
      // A private package never reaches a registry, so there is no tarball to keep it out of.
      await Bun.write(join(root, 'packages/p/package.json'), manifest('"private":true,'));
      const exempt = await checkPackageShape(root);
      expect(exempt.map((finding) => finding.code)).not.toContain('X_PACKAGE_TEST_ONLY_SHIPPED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The ratchet, over the real repo: no published framework package ships a module only its tests
  // import under a name `files` does not exclude.
  test('no framework package ships a test-only module', async () => {
    const findings = await checkPackageShape(REPO_ROOT);
    expect(
      findings
        .filter((finding) => finding.code === 'X_PACKAGE_TEST_ONLY_SHIPPED')
        .map((finding) => finding.at),
    ).toEqual([]);
  });
});
