// `processRoot`: this process's root is its own, a dead process's root is reaped, a live one never.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no directory test or recursive remove of its own.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { processRoot } from './process-root-fixture';

/** This suite's own root, made per process the way it asks every other suite to. */
const SANDBOX = processRoot(join(import.meta.dir, '..', '.process-root-fixture'));

/** A pid no process holds: one that just exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['bun', '-e', '0'], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  return child.pid;
}

const runDir = (pid: number): string => join(SANDBOX, `run-${String(pid)}`);

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe('processRoot', () => {
  test('answers <base>/run-<this pid>', () => {
    expect(processRoot(SANDBOX)).toBe(join(SANDBOX, `run-${String(process.pid)}`));
  });

  test('reaps the root of a process that has exited', async () => {
    const dead = runDir(await deadPid());
    mkdirSync(join(dead, 'apps'), { recursive: true });
    processRoot(SANDBOX);
    expect(existsSync(dead)).toBe(false);
  });

  test('never touches a live process root, its own, or an entry not named run-<pid>', () => {
    // The parent — the `bun test` runner or the shell — is alive for as long as this test runs.
    const live = runDir(process.ppid);
    const own = runDir(process.pid);
    const other = join(SANDBOX, 'run-notapid');
    for (const dir of [live, own, other]) mkdirSync(dir, { recursive: true });
    processRoot(SANDBOX);
    expect([live, own, other].map((dir) => existsSync(dir))).toEqual([true, true, true]);
  });

  test('a base no run has created yet is not an error', () => {
    const absent = join(SANDBOX, 'never-made');
    expect(processRoot(absent)).toBe(join(absent, `run-${String(process.pid)}`));
    expect(existsSync(absent)).toBe(false);
  });
});
