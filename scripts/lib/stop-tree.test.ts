// A root script killed by a signal takes its children with it. Before, `bun run preflight` stopped
// by a harness left the coverage gate it started running, holding the ledger reservation it
// inherited, and that gate's own `bun test` workers outlived a SIGTERM sent to it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory native, and a `Bun.file` read while another process writes it
// can answer a stale size; a fresh synchronous read cannot.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path API.
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'stop-tree-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `check` every 25 ms for up to `ms`: the condition is a process's state, not a clock. */
async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await check()) return true;
    // real-clock: another process's state, which no fake timer in this one can move.
    await Bun.sleep(25);
  }
  return check();
}

/** A parent that runs a child through `run()`, the child writing its pid; `guarded` installs the stop. */
async function parentScript(guarded: boolean): Promise<{ parent: number; child: number }> {
  const pidFile = join(dir, `child-${guarded ? 'guarded' : 'bare'}.pid`);
  const script = join(dir, `parent-${guarded ? 'guarded' : 'bare'}.ts`);
  const lib = import.meta.dir;
  await Bun.write(
    script,
    [
      `import { run } from ${JSON.stringify(join(lib, 'run.ts'))};`,
      `import { stopTreeOnSignal } from ${JSON.stringify(join(lib, 'stop-tree.ts'))};`,
      guarded ? "stopTreeOnSignal('stop-tree-test');" : '',
      // real-clock: the child is another process that must still be running when it is stopped.
      `await run(['bun', '-e', ${JSON.stringify(`await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000);`)}], { cwd: ${JSON.stringify(dir)}, timeoutMs: 90000 });`,
    ].join('\n'),
  );
  const parent = Bun.spawn(['bun', script], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  const pid = (): number => {
    try {
      return Number(readFileSync(pidFile, 'utf8')) || 0;
    } catch {
      return 0;
    }
  };
  expect(await until(() => pid() > 0, 20_000)).toBe(true);
  return { parent: parent.pid, child: pid() };
}

// POSIX only: Windows reads no process's environment, and no root script that starts a gate runs
// there (`stop-tree.ts`).
describe.skipIf(process.platform === 'win32')('unit · a stopped script stops its tree', () => {
  test('SIGTERM to the script kills the child it was running', async () => {
    const { parent, child } = await parentScript(true);
    process.kill(parent, 'SIGTERM');
    expect(await until(() => !alive(parent), 10_000)).toBe(true);
    expect(await until(() => !alive(child), 10_000)).toBe(true);
  }, 60_000);

  // The control: without the stop the child is an orphan, which is the defect itself.
  test('without it, the child outlives the script', async () => {
    const { parent, child } = await parentScript(false);
    process.kill(parent, 'SIGTERM');
    expect(await until(() => !alive(parent), 10_000)).toBe(true);
    expect(alive(child)).toBe(true);
    process.kill(child, 'SIGKILL');
  }, 60_000);
});
