// The whole chain on a real Solid island: `runCovered` → `mountIsland` → `buildIslands` with the
// coverage build → the recorded map → the lines `mount` and the component ran, counted for the
// `.island.tsx` file itself. What an app's `unit` step does, on one island.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import { processRoot } from './process-root-fixture';
import { runCovered } from './verify-coverage-run';

// Under this package, so the build resolves `solid-js` the way an app's does.
const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'coverage-run'));
const ISLAND = 'apps/web/app/badge.island.tsx';
const SOURCE = [
  "import { render } from 'solid-js/web';",
  '',
  'function Badge(props: { n: number }) {',
  "  const label = 'n=' + String(props.n);",
  '  return <b class="badge">{label}</b>;',
  '}',
  '',
  'export function mount(el: HTMLElement, props: { n: number }) {',
  '  const n = props.n;',
  '  return render(() => <Badge n={n} />, el);',
  '}',
  '',
].join('\n');

const TEST = [
  "import { expect, test } from 'bun:test';",
  `import { buildIslands } from ${JSON.stringify(join(import.meta.dir, 'island-bundle.ts'))};`,
  `import { mountIsland } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'testing', 'src', 'fixture-island.ts'))};`,
  "test('badge', async () => {",
  `  const mounted = await mountIsland({ build: buildIslands, root: process.cwd(), file: ${JSON.stringify(ISLAND)}, props: { n: 2 } });`,
  "  expect(mounted.text('b')).toBe('n=2');",
  '  mounted[Symbol.dispose]();',
  '});',
  '',
].join('\n');

describe('runCovered over a Solid island built by buildIslands', () => {
  test("the component's and mount's lines count for the .island.tsx source", async () => {
    await rm(ROOT, { recursive: true, force: true });
    try {
      await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'coverage-run' }));
      await Bun.write(join(ROOT, ISLAND), SOURCE);
      await Bun.write(join(ROOT, 'apps/web/app/badge.island.test.ts'), TEST);
      const run = await runCovered({
        root: ROOT,
        runner: exec,
        files: ['apps/web/app/badge.island.test.ts'],
        workers: 1,
      });
      expect(run.output ?? '').toBe('');
      expect(run.ok).toBe(true);
      const island = run.coverage[ISLAND];
      if (island === undefined) expect.unreachable('the mount credited nothing to the island');
      // Line 4 is the component body, line 9 mount's: neither runs anywhere but the chunk. A line
      // Babel rewrote (the JSX on 5 and 10) holds other text in the build and is credited nothing.
      expect(island.hit).toEqual(expect.arrayContaining([4, 9]));
      expect(island.hit).not.toContain(10);
    } finally {
      await rm(ROOT, { recursive: true, force: true });
    }
  }, 120_000);
});
