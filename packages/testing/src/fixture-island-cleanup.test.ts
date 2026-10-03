// The island fixture's scratch directories: one per mount, gone when the mount is. In-process for
// a mount's own lifetime; in a child `bun test` run for what a file or a run leaves undisposed —
// `process.on('exit')` never fires under `bun test`, so only the run's own hooks can remove those.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountIsland } from './fixture-island';
import { islandScratchDirs } from './island-scratch';
import { testName } from './test-types';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MODULE = join(import.meta.dir, 'fixture-island.ts');
const SCRATCH = join(import.meta.dir, 'island-scratch.ts');
const FILE = 'apps/web/site/count.island.tsx';
const COUNTER = 'let n = 0; export function mount(el) { n += 1; el.textContent = String(n); }';

const buildOf = (code: string) => () => Promise.resolve({ chunks: [{ file: FILE, code }] });
const mount = (code: string) => mountIsland({ build: buildOf(code), root: '/r', file: FILE });

describe(testName('unit', 'a mount owns its scratch directory'), () => {
  test('two mounts of byte-identical chunks are two module instances', async () => {
    using first = await mount(COUNTER);
    using second = await mount(COUNTER);
    expect(first.el.textContent).toBe('1');
    expect(second.el.textContent).toBe('1');
  });

  test('dispose removes the directory the mount imported from', async () => {
    const before = new Set(islandScratchDirs());
    const mounted = await mount(COUNTER);
    const [dir] = islandScratchDirs().filter((each) => !before.has(each));
    expect(dir ?? '').toContain('ultimate-island-');
    expect(existsSync(dir ?? '')).toBe(true);
    mounted[Symbol.dispose]();
    expect(existsSync(dir ?? '')).toBe(false);
    expect(islandScratchDirs()).not.toContain(dir);
  });

  test('a mount that throws removes its directory before it rethrows', async () => {
    const before = islandScratchDirs().length;
    const failing = 'export function mount() { throw new Error("island refused"); }';
    await expect(mount(failing)).rejects.toThrow('island refused');
    expect(islandScratchDirs()).toHaveLength(before);
  });
});

/** Two files in one child run: the first leaks a mount, the second leaks another. */
const probeFile = (label: string): string => `
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
const { mountIsland } = await import(${JSON.stringify(MODULE)});
const { islandScratchDirs } = await import(${JSON.stringify(SCRATCH)});
test('${label}', async () => {
  const seen = globalThis.__islandProbeDirs ?? [];
  console.log('PROBE ' + JSON.stringify({ label: '${label}', live: islandScratchDirs(), stale: seen.filter((d) => existsSync(d)) }));
  const build = () => Promise.resolve({ chunks: [{ file: 'a.island.tsx', code: 'export function mount() {}' }] });
  await mountIsland({ build, root: '/r', file: 'a.island.tsx' });
  globalThis.__islandProbeDirs = [...seen, ...islandScratchDirs()];
  console.log('LEAKED ' + JSON.stringify(islandScratchDirs()));
});
`;

interface ProbeLine {
  readonly label: string;
  readonly live: readonly string[];
  readonly stale: readonly string[];
}

const runChild = async (dir: string): Promise<string> => {
  const child = Bun.spawn(['bun', 'test', join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) expect.unreachable(`the child run failed: ${out}${err}`);
  return out;
};

describe(testName('unit', 'a bun test run leaves no island directory behind'), () => {
  test('an undisposed mount is removed at the file boundary and at the end of the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'island-cleanup-probe-'));
    try {
      await Bun.write(join(dir, 'a.test.ts'), probeFile('a'));
      await Bun.write(join(dir, 'b.test.ts'), probeFile('b'));
      const out = await runChild(dir);
      const lines = out.split('\n');
      const probes = lines
        .filter((line) => line.startsWith('PROBE '))
        .map((line) => JSON.parse(line.slice('PROBE '.length)) as ProbeLine);
      const leaked = lines
        .filter((line) => line.startsWith('LEAKED '))
        .flatMap((line) => JSON.parse(line.slice('LEAKED '.length)) as string[]);
      expect(probes.map((each) => each.label).sort()).toEqual(['a', 'b']);
      const second = probes[1] as ProbeLine;
      // The boundary between the files disposed the first file's mount and removed its directory.
      expect(second.live).toEqual([]);
      expect(second.stale).toEqual([]);
      expect(leaked).toHaveLength(2);
      // The second file's mount was disposed by nobody but the run's own `afterAll`.
      for (const each of leaked) expect(existsSync(each)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
