// The two facts a scaffolded island cannot get wrong: the filename the bundler discovers it by,
// and the `mount` export the hydration runtime calls. Everything else in the file is example code;
// these two are the contract, so they are what the generator is pinned on.

import { describe, expect, test } from 'bun:test';
import { islandFiles } from './island';

const filesFor = (name: string, dir = 'apps/web/site/pricing'): readonly string[] =>
  islandFiles(name, { dir }).map((file) => file.path);

const sourceOf = (name: string): string =>
  String(islandFiles(name, { dir: 'apps/web/site' })[0]?.contents ?? '');

describe('unit · x g island', () => {
  test('the entry carries the one extension the bundler discovers a client entry by', () => {
    expect(filesFor('currency-picker')).toEqual([
      'apps/web/site/pricing/currency-picker.island.tsx',
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

  test('the emitted test fails if mount is renamed away', () => {
    const spec = String(islandFiles('counter', { dir: 'apps/web/site' })[1]?.contents ?? '');
    expect(spec).toContain("import * as entry from './counter.island'");
    expect(spec).toContain("expect(typeof entry.mount).toBe('function')");
  });
});
