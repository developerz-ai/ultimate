// An island retains the `ui.*` keys of the components it renders and no others. `UI_KEYS` was one
// object literal, and a bundler cannot drop a property of an object one member read keeps alive:
// a `<Spinner>` shipped all of the design system's keys. Built here, minified, as a browser chunk.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no directory-removal API; the entry is written inside this package, like
// `scripts/ui-barrel-bytes.test.ts`', so the build resolves it from here.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API.
import { join } from 'node:path';
import { UI_KEYS } from './i18n-keys';

const DIR = join(import.meta.dir, '..', '.tmp', `keys-shake-${process.pid}`);

afterAll(() => rm(DIR, { recursive: true, force: true }));

/** The `ui.*` keys a minified browser chunk of `source` carries. */
async function keysIn(source: string): Promise<readonly string[]> {
  const entry = join(DIR, `entry-${Bun.hash(source).toString(36)}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true });
  const chunk = built.outputs[0];
  if (chunk === undefined) return expect.unreachable(`${entry} built no chunk`);
  const text = await chunk.text();
  return Object.values(UI_KEYS).filter((key) => text.includes(`"${key}"`));
}

const from = JSON.stringify(join(import.meta.dir, 'i18n-keys'));

describe('UI_KEYS in a browser chunk', () => {
  test('one member read retains that key alone', async () => {
    const kept = await keysIn(
      `import { UI_KEYS } from ${from};\nexport const k = UI_KEYS.loading;`,
    );
    expect(kept).toEqual([UI_KEYS.loading]);
  });

  test('two reads retain two', async () => {
    const kept = await keysIn(
      `import { UI_KEYS } from ${from};\nexport const k = [UI_KEYS.close, UI_KEYS.logCapped];`,
    );
    expect([...kept].sort()).toEqual([UI_KEYS.close, UI_KEYS.logCapped].sort());
  });
});
