// The three facts a scaffolded island cannot get wrong: the filename the bundler discovers it by,
// the `mount` export the hydration runtime calls, and that mount RENDERS — reactively. The first
// two are string assertions; the third is the emitted file built by `buildIslands` and driven by
// `mountIsland`, because a template that typechecks and does not mount is the same bug one step
// quieter, and that is exactly what shipped through five majors.

import { describe, expect, test } from 'bun:test';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from '../island-bundle';
import { islandFiles } from './island';
import { fixtureAppRoot } from './island-fixture';

const filesFor = (name: string, dir = 'apps/web/site/pricing'): readonly string[] =>
  islandFiles(name, { dir }).map((file) => file.path);

const sourceOf = (name: string): string =>
  String(islandFiles(name, { dir: 'apps/web/site' })[0]?.contents ?? '');

const DIR = 'apps/web/app/demo';
const ENTRY = `${DIR}/counter.island.tsx`;

describe('unit · x g island', () => {
  test('the entry carries the one extension the bundler discovers a client entry by', () => {
    expect(filesFor('currency-picker')).toEqual([
      'apps/web/site/pricing/currency-picker.island.tsx',
      'apps/web/site/pricing/currency-picker.module.scss',
      'apps/web/site/pricing/currency-picker.island.test.ts',
    ]);
  });

  test('a camelCase or spaced name still lands on a kebab filename', () => {
    // The filename becomes the moduleId in the HTML, the chunk URL and the budget report, so a
    // second casing here would be three surfaces disagreeing about one island's name.
    expect(filesFor('CurrencyPicker')[0]).toBe('apps/web/site/pricing/currency-picker.island.tsx');
  });

  test('a trailing slash on --at does not produce a doubled path segment', () => {
    expect(filesFor('counter', 'apps/web/site/pricing/')[0]).toBe(
      'apps/web/site/pricing/counter.island.tsx',
    );
  });

  test('the entry exports mount, and shows the island() line that names it', () => {
    const source = sourceOf('counter');
    expect(source).toContain('export function mount(');
    // The declaration goes on the PAGE, so the scaffold has to say so — an island file that looks
    // self-registering is an island nothing ever renders.
    expect(source).toContain("island({ src: './counter.island.tsx'");
  });

  test('the emitted test names the island app-root-relative, as discoverIslands reports it', () => {
    const spec = String(islandFiles('counter', { dir: DIR })[2]?.contents ?? '');
    expect(spec).toContain(`const ISLAND = '${ENTRY}'`);
    // One `..` per directory segment. A miscounted root is a test that reports the island was
    // never built, naming a file the author can see on disk.
    expect(spec).toContain("join(import.meta.dir, '..', '..', '..', '..')");
  });
});

describe('unit · the island x g island emits actually mounts', () => {
  test('it replaces the shell, and a click reaches the DOM', async () => {
    using root = await fixtureAppRoot('island', islandFiles('counter', { dir: DIR }));
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: { label: 'Open' },
      shell: '<span>server</span>',
    });

    expect(mounted.find('span')).toBeNull();
    // A chunk that fell back to the classic React factory names a global that is not in it, and
    // `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    expect(mounted.text('[data-role="count"]')).toBe('0');
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('[data-role="count"]')).toBe('1');
  }, 60_000);

  // The mutation, run rather than described: break the one thing the case above is for — the
  // signal read that reaches the DOM — and the assertion must notice. A test that cannot fail is
  // not a test, and this is the half of that claim a reader can check.
  test('a count that never re-reads the signal fails the same assertion', async () => {
    const emitted = islandFiles('counter', { dir: DIR }).map((file) =>
      file.path === ENTRY
        ? { ...file, contents: String(file.contents).replace('{count()}', '{0}') }
        : file,
    );
    using root = await fixtureAppRoot('island-inert', emitted);
    using mounted = await mountIsland({
      build: buildIslands,
      root: root.path,
      file: ENTRY,
      props: { label: 'Open' },
    });

    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.text('[data-role="count"]')).not.toBe('1');
  }, 60_000);
});
