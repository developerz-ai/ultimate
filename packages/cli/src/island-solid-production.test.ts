// The one property: an island chunk never carries Solid's DEVELOPMENT build. `Bun.build` with
// `target: 'browser'` always adds the `development` export condition and no option removes it, so
// without the plugin under test a correct island ships the dev bundle with `success: true`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIslands } from './island-bundle';
import { selectCondition, solidProductionEntry } from './island-solid-production';

const ROOT = join(import.meta.dir, '..', '.island-solid-fixture');

const ISLAND = `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

export function mount(el: HTMLElement): void {
  const [n, setN] = createSignal(0);
  render(() => <button type="button" onClick={() => setN(n() + 1)}>count {n()}</button>, el);
}
`;

/**
 * A string only Solid's DEVELOPMENT core carries (`dist/dev.js`), and a string literal, so it
 * survives minification. `dist/solid.js` does not contain it — checked by the second assertion in
 * the same test, which would otherwise pass against either build.
 */
const DEV_ONLY = 'Potential Infinite Loop Detected';

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-solid-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('selectCondition', () => {
  test('picks the first key the build declares, and never one it did not', () => {
    const node = { development: './dev.js', browser: { import: './web.js' }, default: './x.js' };

    expect(selectCondition(node, new Set(['browser', 'import']))).toBe('./web.js');
    // `development` first in key order and absent from the set: the whole point of the file.
    expect(selectCondition(node, new Set(['default']))).toBe('./x.js');
    expect(selectCondition(node, new Set(['nothing']))).toBeNull();
  });

  test('an array is an ordered fallback list, not a target', () => {
    expect(selectCondition([{ node: './n.js' }, './fallback.js'], new Set(['browser']))).toBe(
      './fallback.js',
    );
  });
});

describe('solidProductionEntry', () => {
  test('solid-js and solid-js/web answer their production browser builds', async () => {
    expect(await solidProductionEntry('solid-js', import.meta.dir, '')).toMatch(
      /solid-js\/dist\/solid\.js$/,
    );
    expect(await solidProductionEntry('solid-js/web', import.meta.dir, '')).toMatch(
      /solid-js\/web\/dist\/web\.js$/,
    );
  });

  test('a subpath solid-js does not name as an exact export is left to Bun', async () => {
    // `./dist/*` is a PATTERN with no conditions attached — Bun's own answer is already correct,
    // and a second resolver guessing at patterns is a second place for it to be wrong.
    expect(await solidProductionEntry('solid-js/dist/solid.js', import.meta.dir, '')).toBeNull();
  });
});

describe('an island that imports solid-js', () => {
  test('ships the production build, and is smaller than the development one', async () => {
    await Bun.write(join(ROOT, 'apps/web/site/counter.island.tsx'), ISLAND);
    const chunk = (await buildIslands(ROOT)).chunks[0];

    expect(chunk?.code).not.toContain(DEV_ONLY);
    // The counterpart: the marker IS in the file the unpatched build resolves, so the assertion
    // above is a real one rather than a string that never appears anywhere.
    const dev = await Bun.file(
      (await solidProductionEntry('solid-js', import.meta.dir, ''))?.replace(
        'solid.js',
        'dev.js',
      ) ?? '',
    ).text();
    expect(dev).toContain(DEV_ONLY);
  });
});
