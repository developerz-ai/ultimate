// An island's own source counts in an app's coverage: a real `mountIsland` over a built chunk, run
// by `runCovered` in real `bun test` processes, credits the lines `mount` ran to the island file —
// not to the temp file the fixture imported, which the app's floor never sees.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import { runCovered } from './verify-coverage-run';

const ISLAND = 'apps/web/app/counter.island.ts';
/** The writer `mountIsland` is, by source path: a temp app resolves no `@ultimat3/*` package. */
const FIXTURE = join(import.meta.dir, '..', '..', 'testing', 'src', 'fixture-island.ts');

/** `mount`'s body is lines 6–7; `label`'s is line 2. */
const ISLAND_SOURCE = [
  'export function label(n: number): string {',
  "  return 'count ' + String(n);",
  '}',
  '',
  'export function mount(el: { textContent: string }, props: { n: number }): void {',
  '  const text = label(props.n);',
  '  el.textContent = text;',
  '}',
  '',
].join('\n');

/**
 * The builder an app hands `mountIsland`, reduced to one island: what `buildIslands` must do under
 * `coverage` — keep the lines, hand over the map — and the shipped minified bytes otherwise.
 */
const MOUNT_TEST = (mount: boolean, load: boolean): string =>
  [
    "import { expect, test } from 'bun:test';",
    `import { mountIsland } from ${JSON.stringify(FIXTURE)};`,
    load ? "import { label } from './counter.island';" : '',
    'const build = async (root: string, options?: { coverage?: boolean }) => {',
    `  const file = ${JSON.stringify(ISLAND)};`,
    '  const built = await Bun.build({',
    "    entrypoints: [root + '/' + file], target: 'browser', format: 'esm', sourcemap: 'external',",
    '    minify: options?.coverage === true ? { whitespace: false, syntax: true, identifiers: true } : true,',
    '  });',
    "  const code = await built.outputs.find((one) => one.kind === 'entry-point')!.text();",
    "  const map = await built.outputs.find((one) => one.kind === 'sourcemap')?.text();",
    '  return { chunks: [{ file, code, ...(map === undefined ? {} : { map }) }] };',
    '};',
    "test('island', async () => {",
    load ? "  expect(typeof label).toBe('function');" : '',
    mount
      ? `  const mounted = await mountIsland({ build, root: process.cwd(), file: ${JSON.stringify(ISLAND)}, props: { n: 3 } });`
      : '',
    mount ? "  expect(mounted.el.textContent).toBe('count 3');" : '',
    mount ? '  mounted[Symbol.dispose]();' : '',
    '});',
    '',
  ].join('\n');

async function islandApp(tests: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-covered-island-'));
  await Bun.write(join(root, ISLAND), ISLAND_SOURCE);
  for (const [file, text] of Object.entries(tests)) await Bun.write(join(root, file), text);
  return root;
}

describe('runCovered over a mounted island', () => {
  test('a chunk mount alone credits the island source the lines mount ran', async () => {
    const root = await islandApp({
      'apps/web/app/counter.island.test.ts': MOUNT_TEST(true, false),
    });
    try {
      const run = await runCovered({
        root,
        runner: exec,
        files: ['apps/web/app/counter.island.test.ts'],
        workers: 1,
      });
      expect(run.output ?? '').toBe('');
      expect(run.ok).toBe(true);
      const island = run.coverage[ISLAND];
      if (island === undefined) expect.unreachable('the mount credited nothing to the island');
      expect(island.hit).toEqual(expect.arrayContaining([2, 6, 7]));
      // Still a whole file's line set — never a record of only the lines that ran.
      expect(island.miss.length + island.hit.length).toBeGreaterThanOrEqual(6);
      expect(island.funcsHit).toBe(0);
      // No temp chunk path reaches the app's map.
      expect(Object.keys(run.coverage).every((file) => /^(apps|packages)\//.test(file))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a source another process only loaded keeps its line set, and mount's lines turn hit", async () => {
    const root = await islandApp({
      'apps/web/app/counter.island.test.ts': MOUNT_TEST(true, false),
      'apps/web/site/loads.test.ts': MOUNT_TEST(false, true).replace(
        "'./counter.island'",
        "'../app/counter.island'",
      ),
    });
    try {
      const run = await runCovered({
        root,
        runner: exec,
        files: ['apps/web/app/counter.island.test.ts', 'apps/web/site/loads.test.ts'],
        workers: 2,
        sliceFiles: 1,
      });
      expect(run.ok).toBe(true);
      const island = run.coverage[ISLAND];
      if (island === undefined) expect.unreachable('the loading process wrote a record');
      expect(island.hit).toEqual(expect.arrayContaining([6, 7]));
      expect(island.miss).not.toContain(6);
      expect(island.miss).not.toContain(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('one process that loads and mounts turns the direct misses hit', async () => {
    const root = await islandApp({ 'apps/web/app/counter.island.test.ts': MOUNT_TEST(true, true) });
    try {
      const run = await runCovered({
        root,
        runner: exec,
        files: ['apps/web/app/counter.island.test.ts'],
        workers: 1,
      });
      expect(run.ok).toBe(true);
      const island = run.coverage[ISLAND];
      if (island === undefined) expect.unreachable('the test loaded the island source');
      expect(island.hit).toEqual(expect.arrayContaining([6, 7]));
      expect(island.miss).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
