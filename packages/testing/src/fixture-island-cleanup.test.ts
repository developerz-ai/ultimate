// The island fixture's scratch DIRECTORY, which is a process-lifetime fact and so cannot be
// asserted from inside the process that owns it: a sibling test file may already have mounted, and
// "gone at exit" is only visible after the exit. Both halves run in a child instead.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { testName } from './test-types';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MODULE = join(import.meta.dir, 'fixture-island.ts');

/**
 * Import, assert nothing was created yet, mount one island, print the directory. The parent reads
 * the last line and looks at the filesystem once the child is gone.
 */
const PROBE = `
const { islandModuleDir, mountIsland } = await import(${JSON.stringify(MODULE)});
const before = islandModuleDir();
const build = () =>
  Promise.resolve({ chunks: [{ file: 'a.island.tsx', code: 'export function mount(el) { el.textContent = ""; }' }] });
using mounted = await mountIsland({ build, root: '/tmp/island-cleanup-root', file: 'a.island.tsx' });
void mounted;
console.log(JSON.stringify({ before: before ?? null, after: islandModuleDir() ?? null }));
`;

interface Probe {
  readonly before: string | null;
  readonly after: string | null;
}

const runProbe = async (): Promise<Probe> => {
  const child = Bun.spawn(['bun', '-e', PROBE], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const line = out.trim().split('\n').at(-1) ?? '';
  if (code !== 0 || line === '') {
    expect.unreachable(
      `the probe exited ${String(code)} and printed ${out || '(nothing)'}; ${err}`,
    );
  }
  return JSON.parse(line) as Probe;
};

describe(testName('unit', 'the island fixture leaves no temp directory behind'), () => {
  /**
   * `MODULE_DIR` was `mkdtempSync`'d at module scope and never removed, so every test process in
   * the repo that imported `@ultimat3/testing` — this module is on the `.` barrel, so `expect`
   * alone did it — left one empty directory in `/tmp`, forever.
   */
  test('importing the module creates nothing, and a mount is cleaned up at exit', async () => {
    const probe = await runProbe();
    expect(probe.before).toBeNull();
    expect(probe.after).not.toBeNull();
    expect(probe.after ?? '').toContain('ultimate-island-');
    // The child has exited, so its `exit` handler has run.
    expect(existsSync(probe.after ?? '')).toBe(false);
  });
});
