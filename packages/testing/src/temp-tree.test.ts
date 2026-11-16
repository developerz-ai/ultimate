// `tempTree` against real git and real children: its git runs none of the background work that
// outlives a commit, `dispose()` waits for every child before it removes anything, and a tree that
// survives its own remove is a coded failure, never a silent leftover.

import { describe, expect, test } from 'bun:test';
// why: Bun has no existence check for a directory and no recursive remove.
import { existsSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { TrackedChild } from './temp-tree';
import { TEMP_TREE_GIT_ENV, tempTree } from './temp-tree';

/** The residue test's own cleanup: the tree it made survive is still the file's to remove. */
const tempTreeRemoved = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
  expect(existsSync(path)).toBe(false);
};

/**
 * A child under the test's hand: it exits when `exit` is called, and records the signals that
 * reached it — dying of one only when `diesOnKill`, as a real process takes its time otherwise.
 */
const heldChild = (diesOnKill = false) => {
  let exit: (code: number) => void = () => undefined;
  const signals: unknown[] = [];
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  let exitCode: number | null = null;
  void exited.then((code) => {
    exitCode = code;
  });
  const child: TrackedChild = {
    exited,
    get exitCode() {
      return exitCode;
    },
    kill: (signal) => {
      signals.push(signal);
      if (diesOnKill) exit(137);
    },
  };
  return { child, signals, exit: (code: number) => exit(code) };
};

describe('tempTree', () => {
  test('its git commits with none of the background work that outlives the command', async () => {
    await using tree = tempTree('ultimate-temp-tree-');
    expect((await tree.git(['init', '-q'])).code).toBe(0);
    await Bun.write(join(tree.path, 'a.txt'), 'a\n');
    expect((await tree.git(['add', '-A'])).code).toBe(0);
    // No identity on the box is no failure here: the tree's own config carries one.
    expect((await tree.git(['commit', '-qm', 'one'])).code).toBe(0);
    const read = async (key: string) => (await tree.git(['config', '--get', key])).stdout.trim();
    expect(await read('maintenance.auto')).toBe('false');
    expect(await read('gc.auto')).toBe('0');
    expect(await read('core.fsmonitor')).toBe('false');
  });

  test('gitEnv reaches a git the code under test spawns itself', async () => {
    await using tree = tempTree('ultimate-temp-tree-');
    const child = tree.track(
      Bun.spawn(['git', 'config', '--get', 'maintenance.auto'], {
        cwd: tree.path,
        env: { ...Bun.env, ...tree.gitEnv },
        stdout: 'pipe',
        timeout: 30_000,
      }),
    );
    expect((await new Response(child.stdout).text()).trim()).toBe('false');
    expect(tree.gitEnv).toBe(TEMP_TREE_GIT_ENV);
  });

  test('dispose() removes nothing until every tracked child has exited', async () => {
    const tree = tempTree('ultimate-temp-tree-');
    const { child, exit } = heldChild();
    tree.track(child);
    // A child that still runs is the one that writes under the tree after its remove began.
    let removed = false;
    const disposing = tree.dispose().then(() => {
      removed = true;
    });
    // A full event-loop turn: every microtask the dispose could run without the child has run.
    await Bun.sleep(0);
    expect(removed).toBe(false);
    expect(existsSync(tree.path)).toBe(true);
    exit(0);
    await disposing;
    expect(removed).toBe(true);
    expect(existsSync(tree.path)).toBe(false);
  });

  test('a child still running is ended, then awaited, then the tree goes', async () => {
    const tree = tempTree('ultimate-temp-tree-');
    const { child, signals } = heldChild(true);
    tree.track(child);
    await tree.dispose();
    expect(signals).toEqual(['SIGKILL']);
    expect(existsSync(tree.path)).toBe(false);
  });

  test('dispose() twice is one removal', async () => {
    const tree = tempTree('ultimate-temp-tree-');
    const first = tree.dispose();
    expect(tree.dispose()).toBe(first);
    await first;
    expect(existsSync(tree.path)).toBe(false);
  });

  test('a tree that survives its own remove is X_TEST_TEMP_TREE_LEFT, naming what is left', async () => {
    // Bun's recursive remove meeting an entry that vanished under it: it stops, and says nothing.
    const tree = tempTree('ultimate-temp-tree-', { remove: () => undefined });
    await Bun.write(join(tree.path, 'HEAD'), 'ref: refs/heads/main\n');
    const outcome = await tree.dispose().catch((error: unknown) => error);
    expect(outcome).toBeUltimateError('X_TEST_TEMP_TREE_LEFT');
    expect(String((outcome as { cause: string }).cause)).toContain('HEAD');
    tempTreeRemoved(tree.path);
  });
});
