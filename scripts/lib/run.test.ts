// The scripts' one subprocess boundary. The guard it throws is the same guard
// `packages/cli/src/exec.ts` makes at the same seam, and for the same reason — it used to be a
// bare `RangeError`: no code, no `fix:`, nothing a `--json` reader can act on.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory native; the space-in-path case needs a throwaway checkout.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path API; the expected root is spelt with the host separator.
import { join, resolve } from 'node:path';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  LONG_RUN_TIMEOUT_MS,
  REPO_SCAN_TIMEOUT_MS,
  RUN_TIMEOUT_CODE,
  repoRoot,
  run,
} from './run';
import { ScriptError } from './script-error';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('unit · run()', () => {
  test('an empty command is a coded failure, not a bare RangeError', async () => {
    const caught = await run([]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ScriptError);
    expect(caught).not.toBeInstanceOf(RangeError);
    const error = caught as ScriptError;
    expect(error.code).toBe('X_CLI_UNEXPECTED');
    expect(error.cause).toContain('no program to spawn');
    // Executable, and it names the call that fixes it — the shape exec.ts already uses.
    expect(error.fix).toContain('run(["bun", "test"], { cwd })');
    expect(error.toFinding()).toEqual({ code: error.code, cause: error.cause, fix: error.fix });
  });

  test('a real command still runs, captures and times', async () => {
    const result = await run(['bun', '--version'], { cwd: repoRoot() });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a non-zero exit is reported, never thrown', async () => {
    const result = await run(['bun', '-e', 'process.exit(3)'], { cwd: repoRoot() });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test('stdout then stderr, one newline apart, and the exit code', async () => {
    // `bun -e`, not `sh -c`: the windows CI job runs this file on native Windows, which has no
    // POSIX shell. Every child here is Bun itself — the one program the suite already depends on.
    const result = await run(
      ['bun', '-e', 'console.log("out"); console.error("err"); process.exit(3);'],
      { cwd: repoRoot() },
    );
    expect(result).toMatchObject({ code: 3, ok: false, output: 'out\nerr', timedOut: false });
  });
});

// Issue #780: `run()` waited for EOF on the child's pipes with no deadline, and a pipe stays open
// as long as ANY process holds it — git's background maintenance, a pager, a credential helper.
// A CI `unit` shard sat at its 480s step deadline with a test in flight and nothing reported.
describe('unit · run() deadline', () => {
  const cwd = import.meta.dir;

  // A child that spawns a long-lived grandchild inheriting its stdout, prints, then exits: the
  // pipe stays open after the child is gone. The POSIX original was `sh -c 'sleep 30 & echo
  // started'`, which cannot run on windows-latest. One constant, because two tests assert on the
  // same program and its exact text — `run()` echoes `command.join(' ')` into the timeout line.
  const GRANDCHILD =
    'Bun.spawn(["bun","-e","setTimeout(()=>{},60000)"],{stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log("started");process.exit(0);';

  test('a grandchild holding stdout cannot hold the caller past the deadline', async () => {
    const started = performance.now();
    const result = await run(['bun', '-e', GRANDCHILD], { cwd, timeoutMs: 400 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, code: null, timedOut: true });
    // What the child DID print is kept: it is the clue to where it stopped.
    expect(result.output).toContain('started');
    // The coded line names the program that was killed, verbatim: `run()` echoes
    // `command.join(' ')`, so the reported command is the one that actually hung.
    expect(result.output).toContain(`${RUN_TIMEOUT_CODE}: bun -e ${GRANDCHILD}`);
    expect(result.output).toContain('did not finish within 400 ms');
  });

  test('a child that never exits is killed at the deadline', async () => {
    const started = performance.now();
    const result = await run(['bun', '-e', 'setTimeout(() => {}, 60_000);'], {
      cwd,
      timeoutMs: 300,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, code: null, timedOut: true });
  });

  // The pipes are released, not only abandoned: a script whose `run()` timed out still exits,
  // rather than living until the orphan holding its output does.
  test('the calling process exits after a timeout, not when the orphan does', async () => {
    const probe = `import { run } from ${JSON.stringify(join(import.meta.dir, 'run.ts'))};
await run(['bun', '-e', ${JSON.stringify(GRANDCHILD)}], { cwd: ${JSON.stringify(cwd)}, timeoutMs: 200 });`;
    const outer = await run(['bun', '-e', probe], { cwd, timeoutMs: 10_000 });
    expect({ timedOut: outer.timedOut, ok: outer.ok }).toEqual({ timedOut: false, ok: true });
  });

  test("stdin is never the caller's: a reader of it sees EOF at once", async () => {
    // `cat`, the POSIX original, does not exist on windows-latest; a reader that must see EOF is
    // the property, so any stdin reader proves it on both platforms. This one prints nothing.
    const result = await run(['bun', '-e', 'await Bun.stdin.text();'], { cwd, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, code: 0, output: '', timedOut: false });
  });

  test('env is passed through when given', async () => {
    // Exact bytes, no trailing newline: `process.stdout.write` is async on a pipe, but this
    // payload is 4 bytes — far below the 64KB where `process.exit` would drop the queue.
    const result = await run(
      ['bun', '-e', 'process.stdout.write(String(process.env.RUN_PROBE));'],
      {
        cwd,
        env: { ...Bun.env, RUN_PROBE: 'seen' },
      },
    );
    expect(result.output).toBe('seen');
  });

  test('a deadline that is not a positive finite number is a coded refusal', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      // `true`, the POSIX original, does not exist on windows-latest. The deadline is validated
      // before anything is spawned, so the program here only has to be a spawnable one.
      const caught = await run(['bun', '-e', ''], { cwd, timeoutMs }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect({ timeoutMs, code: (caught as ScriptError | undefined)?.code }).toEqual({
        timeoutMs,
        code: 'X_CLI_UNEXPECTED',
      });
    }
  });

  test('the default deadline is finite and the long one is longer', () => {
    expect(Number.isFinite(DEFAULT_RUN_TIMEOUT_MS)).toBe(true);
    expect(LONG_RUN_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RUN_TIMEOUT_MS);
  });
});

describe('unit · repoRoot()', () => {
  const temps: string[] = [];
  afterAll(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test('is this checkout, as a filesystem path the host can open', async () => {
    expect(repoRoot()).toBe(resolve(import.meta.dir, '..', '..'));
    expect(await Bun.file(join(repoRoot(), 'package.json')).exists()).toBe(true);
  });

  /**
   * `URL.pathname` percent-encodes a space and, on Windows, answers `/C:/…`: a checkout under
   * `My Projects` sent every gate script looking for a directory named `My%20Projects`. The module
   * is copied into a root with a space in it, because this checkout's own path has none.
   */
  test('a checkout path with a space is answered decoded, never with %20', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'repo-root-'));
    temps.push(temp);
    const root = join(temp, 'a checkout');
    for (const name of ['run.ts', 'script-error.ts']) {
      await Bun.write(join(root, 'scripts', 'lib', name), Bun.file(join(import.meta.dir, name)));
    }
    const copy: unknown = await import(join(root, 'scripts', 'lib', 'run.ts'));
    const answer = (copy as { readonly repoRoot: () => string }).repoRoot();
    expect(answer).not.toContain('%20');
    expect(answer).toBe(root);
  });
});
