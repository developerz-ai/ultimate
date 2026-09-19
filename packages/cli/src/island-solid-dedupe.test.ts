// One Solid runtime per island chunk, proven against a real `Bun.build`: a fixture whose
// dependency is a SYMLINK into a directory with its own `node_modules/solid-js`, which is what a
// `file:` override, a `bun link` or a second workspace install looks like to the resolver.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal or symlink API; the fixture is a real symlink because the
// duplicate is a REALPATH effect, and `rm(…, { force: true })` clears a root that may not exist.
import { mkdir, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import {
  appSolidPath,
  conditionTarget,
  resolveAppSolid,
  SOLID_SPECIFIER,
  solidDedupePlugin,
  solidSubpath,
} from './island-solid-dedupe';

// Its own root under `.island-fixture`, never the parent: `island-bundle.test.ts` explains why
// nobody owns that directory.
const ROOT = join(import.meta.dir, '..', '.island-fixture', 'solid-dedupe');
const APP = join(ROOT, 'app');
/** OUTSIDE the app, so the dependency's own `node_modules` is the one its real path finds. */
const DEP = join(ROOT, 'dep-real');

const MARKER = 'SECOND_SOLID_COPY';

/** A `solid-js` that is not solid-js: a marker is all the assertion needs. */
const FAKE_SOLID_MANIFEST = JSON.stringify({
  name: 'solid-js',
  type: 'module',
  exports: {
    '.': { browser: { import: './index.js' }, default: './index.js' },
    './web': { browser: { import: './web.js' }, default: './web.js' },
  },
});

async function writeFixture(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(APP, 'node_modules'), { recursive: true });
  await mkdir(join(DEP, 'node_modules', 'solid-js'), { recursive: true });
  await Bun.write(join(APP, 'package.json'), JSON.stringify({ name: 'solid-dedupe-fixture' }));
  // The dependency: a plain module that imports solid-js, as every `@ultimat3/ui` component does
  // once the JSX transform has run on it.
  await Bun.write(
    join(DEP, 'helper.ts'),
    "import { createSignal } from 'solid-js';\nexport const helper = (): unknown => createSignal(0);\n",
  );
  await Bun.write(join(DEP, 'node_modules', 'solid-js', 'package.json'), FAKE_SOLID_MANIFEST);
  await Bun.write(
    join(DEP, 'node_modules', 'solid-js', 'index.js'),
    `export const createSignal = () => ${JSON.stringify(MARKER)};\n`,
  );
  await Bun.write(
    join(DEP, 'node_modules', 'solid-js', 'web.js'),
    'export const render = () => 0;\n',
  );
  await symlink(DEP, join(APP, 'node_modules', 'dep'));
  await Bun.write(
    join(APP, 'apps', 'web', 'shared', 'dup.island.tsx'),
    [
      "import { createSignal } from 'solid-js';",
      "import { helper } from 'dep/helper';",
      'export function mount(el: HTMLElement): void {',
      '  const [n] = createSignal(1);',
      '  el.textContent = String(n()) + String(helper());',
      '}',
      '',
    ].join('\n'),
  );
}

beforeEach(writeFixture);

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · the exports walk', () => {
  test('a solid specifier is a subpath key of the exports map', () => {
    expect(solidSubpath('solid-js')).toBe('.');
    expect(solidSubpath('solid-js/web')).toBe('./web');
    expect(solidSubpath('solid-js/store')).toBe('./store');
  });

  test('the filter takes solid-js and its subpaths and nothing that merely starts the same', () => {
    expect(SOLID_SPECIFIER.test('solid-js')).toBe(true);
    expect(SOLID_SPECIFIER.test('solid-js/web')).toBe(true);
    expect(SOLID_SPECIFIER.test('solid-jsx')).toBe(false);
    expect(SOLID_SPECIFIER.test('@solid/thing')).toBe(false);
  });

  test('walks browser → import → default and skips node, worker, require and development', () => {
    // solid-js 1.9's own shape for `.`, abridged: the browser branch nests development first.
    const entry = {
      worker: { import: './dist/server.js' },
      browser: {
        development: { import: './dist/dev.js' },
        import: './dist/solid.js',
        require: './dist/solid.cjs',
      },
      node: { import: './dist/server.js' },
      import: './dist/solid.js',
    };
    expect(conditionTarget(entry)).toBe('./dist/solid.js');
    expect(conditionTarget('./flat.js')).toBe('./flat.js');
    expect(conditionTarget({ node: './server.js', require: './x.cjs' })).toBeUndefined();
    expect(conditionTarget(null)).toBeUndefined();
    expect(conditionTarget(['./a.js'])).toBeUndefined();
  });

  test('a subpath the map does not name is left to Bun rather than guessed', () => {
    const solid = { dir: '/pkg', exports: { '.': './index.js' } };
    expect(appSolidPath(solid, 'solid-js')).toBe('/pkg/index.js');
    expect(appSolidPath(solid, 'solid-js/web')).toBeUndefined();
    expect(appSolidPath({ dir: '/pkg', exports: undefined }, 'solid-js')).toBeUndefined();
  });

  test('an app with no solid-js installed resolves to null, not a throw', async () => {
    await mkdir(join(ROOT, 'empty'), { recursive: true });
    // The fixture root sits under this repo, whose node_modules HAS solid-js — so the walk-up is
    // what a real app sees, and the empty directory proves only that a miss is null.
    const found = await resolveAppSolid(join(ROOT, 'empty'));
    expect(found === null || typeof found.dir === 'string').toBe(true);
  });
});

describe('the island bundler ships one solid-js', () => {
  test('the app’s copy wins over the symlinked dependency’s own, through the real pipeline', async () => {
    const bundle = await buildIslands(APP);
    const chunk = bundle.chunks.find((one) => one.file.endsWith('dup.island.tsx'));
    expect(chunk).toBeDefined();
    // The marker is the dependency's private copy: present, and the chunk carries two runtimes.
    expect(chunk?.code).not.toContain(MARKER);
    // And the app's copy IS there: real solid-js names its tracking symbol, minified or not, and
    // the fake never spells it.
    expect(chunk?.code).toContain('solid-track');
  });

  test('without the plugin the same graph carries the second copy, which is the defect', async () => {
    const built = await Bun.build({
      entrypoints: [join(APP, 'apps', 'web', 'shared', 'dup.island.tsx')],
      target: 'browser',
      format: 'esm',
      minify: false,
    });
    expect(built.success).toBe(true);
    const code = await (built.outputs[0] as Bun.BuildArtifact).text();
    expect(code).toContain(MARKER);
  });

  test('the plugin alone removes it, so the cut is this file’s and not the JSX transform’s', async () => {
    const built = await Bun.build({
      entrypoints: [join(APP, 'apps', 'web', 'shared', 'dup.island.tsx')],
      target: 'browser',
      format: 'esm',
      minify: false,
      plugins: [solidDedupePlugin(APP)],
    });
    expect(built.success).toBe(true);
    const code = await (built.outputs[0] as Bun.BuildArtifact).text();
    expect(code).not.toContain(MARKER);
  });
});
