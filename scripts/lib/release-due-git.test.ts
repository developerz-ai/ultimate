// The spawn `release-due` runs everything through: it returns by its deadline whatever the child
// does — sleeps, waits on stdin, or exits leaving a grandchild that holds its pipes open.

import { describe, expect, test } from 'bun:test';
import { bounded, gitEnv } from './release-due-git';
import { run } from './run';

const cwd = import.meta.dir;

describe('unit · release-due-git · bounded', () => {
  // The CI hang's shape (PR #779): the command exits, a process it started keeps stdout open, and
  // a reader waiting for EOF waits as long as that process lives. `run()` is such a reader.
  test('a grandchild holding stdout cannot hold the caller past the deadline', async () => {
    const started = performance.now();
    const out = await bounded(['sh', '-c', 'sleep 3 & echo started'], { cwd, timeoutMs: 400 });
    expect(out.timedOut).toBe(true);
    expect(out.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('lib/run.ts run() is that unbounded reader, which is why release-due does not use it', async () => {
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 1_000));
    const settled = await Promise.race([
      run(['sh', '-c', 'sleep 3 & echo started'], { cwd }),
      late,
    ]);
    expect(settled).toBe('late');
  });

  test('a child that never exits is killed at the deadline', async () => {
    const started = performance.now();
    const out = await bounded(['sleep', '30'], { cwd, timeoutMs: 300 });
    expect(out).toMatchObject({ ok: false, timedOut: true, code: null });
    expect(out.output).toContain('did not finish within 300 ms');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("stdin is never the caller's: a reader of it sees EOF at once", async () => {
    const out = await bounded(['cat'], { cwd, timeoutMs: 5_000 });
    expect(out).toEqual({ ok: true, code: 0, output: '', timedOut: false });
  });

  test('a normal command answers its output and exit code', async () => {
    expect(await bounded(['sh', '-c', 'echo out; echo err >&2; exit 3'], { cwd })).toEqual({
      ok: false,
      code: 3,
      output: 'out\nerr',
      timedOut: false,
    });
  });
});

describe('unit · release-due-git · gitEnv', () => {
  test('no inherited GIT_* reaches git, and nothing it runs can prompt or page', () => {
    const env = gitEnv({ GIT_AUTHOR_NAME: 't' }, { PATH: '/bin', GIT_DIR: '/elsewhere/.git' });
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_AUTHOR_NAME: 't',
    });
  });
});
