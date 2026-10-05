// One copy of each framework package per island chunk, proven against a real `Bun.build`: a
// fixture whose `@ultimat3/beta` carries its OWN nested `@ultimat3/alpha` as plain files — what a
// Windows `file:` install looks like, where no symlink folds the nest into the app's copy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API; `rm(…, { force: true })` clears a root that may not exist.
import { mkdir, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import {
  appPackagePath,
  FRAMEWORK_SPECIFIER,
  frameworkDedupePlugin,
  frameworkDedupePlugins,
  hasNestedFrameworkCopies,
  resolveAppPackage,
  splitFrameworkSpecifier,
} from './island-package-dedupe';

// Its own root under `.island-fixture`: `island-bundle.test.ts` explains why nobody owns the parent.
const ROOT = join(import.meta.dir, '..', '.island-fixture', 'package-dedupe');
const APP = join(ROOT, 'app');
const ALPHA = join(APP, 'node_modules', '@ultimat3', 'alpha');
const BETA = join(APP, 'node_modules', '@ultimat3', 'beta');
const NESTED = join(BETA, 'node_modules', '@ultimat3', 'alpha');
const ISLAND = join(APP, 'apps', 'web', 'shared', 'dup.island.tsx');

const manifest = (name: string): string =>
  JSON.stringify({ name, type: 'module', exports: { '.': './index.js' } });

async function writeFixture(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(NESTED, { recursive: true });
  await Bun.write(join(APP, 'package.json'), JSON.stringify({ name: 'package-dedupe-fixture' }));
  await Bun.write(join(ALPHA, 'package.json'), manifest('@ultimat3/alpha'));
  await Bun.write(join(ALPHA, 'index.js'), "export const which = () => 'ALPHA_APP_COPY';\n");
  await Bun.write(join(NESTED, 'package.json'), manifest('@ultimat3/alpha'));
  await Bun.write(join(NESTED, 'index.js'), "export const which = () => 'ALPHA_NESTED_COPY';\n");
  await Bun.write(join(BETA, 'package.json'), manifest('@ultimat3/beta'));
  await Bun.write(
    join(BETA, 'index.js'),
    "import { which } from '@ultimat3/alpha';\nexport const viaBeta = () => which();\n",
  );
  await Bun.write(
    ISLAND,
    [
      "import { which } from '@ultimat3/alpha';",
      "import { viaBeta } from '@ultimat3/beta';",
      'export function mount(el: HTMLElement): void {',
      '  el.textContent = which() + viaBeta();',
      '}',
      '',
    ].join('\n'),
  );
}

beforeEach(writeFixture);

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · which copy a framework specifier names', () => {
  test('a specifier splits into its package and its exports key', () => {
    expect(splitFrameworkSpecifier('@ultimat3/core')).toEqual({
      name: '@ultimat3/core',
      subpath: '.',
    });
    expect(splitFrameworkSpecifier('@ultimat3/render/server')).toEqual({
      name: '@ultimat3/render',
      subpath: './server',
    });
  });

  test('the filter takes the framework scope and nothing that merely starts the same', () => {
    expect(FRAMEWORK_SPECIFIER.test('@ultimat3/core')).toBe(true);
    expect(FRAMEWORK_SPECIFIER.test('@ultimat3/core/page')).toBe(true);
    expect(FRAMEWORK_SPECIFIER.test('@ultimat3x/core')).toBe(false);
    expect(FRAMEWORK_SPECIFIER.test('solid-js')).toBe(false);
  });

  test('the app copy is found from the app root; a subpath the map omits is left to Bun', async () => {
    const pkg = await resolveAppPackage(APP, '@ultimat3/alpha');
    expect(pkg?.dir).toBe(ALPHA);
    if (pkg === null) return expect.unreachable('the fixture installs @ultimat3/alpha');
    expect(appPackagePath(pkg, '.')).toBe(join(ALPHA, 'index.js'));
    expect(appPackagePath(pkg, './nope')).toBeUndefined();
    expect(await resolveAppPackage(APP, '@ultimat3/not-installed-anywhere')).toBeNull();
  });
});

describe('the island bundler ships one copy of each framework package', () => {
  test('without the plugin the nested copy ships beside the app’s, which is the defect', async () => {
    const built = await Bun.build({ entrypoints: [ISLAND], target: 'browser', format: 'esm' });
    expect(built.success).toBe(true);
    const code = await (built.outputs[0] as Bun.BuildArtifact).text();
    expect(code).toContain('ALPHA_NESTED_COPY');
  });

  test('the plugin alone folds the nest into the app’s copy', async () => {
    const built = await Bun.build({
      entrypoints: [ISLAND],
      target: 'browser',
      format: 'esm',
      plugins: [frameworkDedupePlugin(APP)],
    });
    expect(built.success).toBe(true);
    const code = await (built.outputs[0] as Bun.BuildArtifact).text();
    expect(code).not.toContain('ALPHA_NESTED_COPY');
    expect(code).toContain('ALPHA_APP_COPY');
  });

  test('and so does the real pipeline', async () => {
    const chunk = (await buildIslands(APP)).chunks.find((one) =>
      one.file.endsWith('dup.island.tsx'),
    );
    expect(chunk?.code).toContain('ALPHA_APP_COPY');
    expect(chunk?.code).not.toContain('ALPHA_NESTED_COPY');
  });
});

describe('unit · the plugin is installed only where a nested copy exists', () => {
  // A hook on every `@ultimat3/*` import turns off Bun's `sideEffects` tree-shaking for them, so a
  // tree whose copies are all symlinks (every Linux `file:` install) must not carry it.
  test('a real nested directory installs it', () => {
    expect(hasNestedFrameworkCopies(APP)).toBe(true);
    expect(frameworkDedupePlugins(APP)).toHaveLength(1);
  });

  test('a nested symlink, which a realpath folds, does not', async () => {
    await rm(NESTED, { recursive: true, force: true });
    await symlink(ALPHA, NESTED, process.platform === 'win32' ? 'junction' : 'dir');
    expect(hasNestedFrameworkCopies(APP)).toBe(false);
    expect(frameworkDedupePlugins(APP, 'linux')).toEqual([]);
    // Windows junctions are not folded by Bun, so there it is installed whatever the tree holds.
    expect(frameworkDedupePlugins(APP, 'win32')).toHaveLength(1);
  });
});
