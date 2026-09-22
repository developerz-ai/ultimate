// `AsyncState` moved here from `@ultimat3/ui` so `realtime` could return what `ui` renders. A
// second declaration of the union anywhere in the framework is the defect that move closed, and a
// type cannot fail a runtime test — so this reads the SOURCE, matched on the literal set rather
// than on the name (a copy called `LoadState` is still a copy; `scripts/render-modes.ts` learned
// that from `PwaRenderMode`). Two shared union arms is a copy; one is a coincidence.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path'; // why: Bun has no path-join native; `Bun.file` takes a joined path.
import { Glob } from 'bun';

const PACKAGES = join(import.meta.dir, '..', '..');
const HOME = join('core', 'src', 'async-state.ts');
const ARM = /\|\s*\{\s*(?:readonly\s+)?status:\s*'(pending|refreshing|ready|failed)'/g;

async function declarers(): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Glob('*/src/**/*.{ts,tsx}').scan(PACKAGES)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const text = await Bun.file(join(PACKAGES, file)).text();
    const arms = new Set([...text.matchAll(ARM)].map((match) => match[1]));
    if (arms.size >= 2) found.push(file);
  }
  return found.sort();
}

describe('AsyncState', () => {
  // Reads every package's source; the default 5s is too tight when the whole suite shares a CPU.
  test('its status union is declared once, in core', async () => {
    expect(await declarers()).toEqual([HOME]);
  }, 30_000);
});
