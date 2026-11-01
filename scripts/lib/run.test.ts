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

  // The child two of the deadline tests below share: it prints `started`, then holds its stdout
  // past the answer `run()` waits on. One property, one spelling per platform — the platforms
  // differ in WHO can hold a pipe, never in whether the deadline answers:
  //
  // - POSIX: the child spawns a long-lived grandchild inheriting its stdout and exits, so the
  //   pipe's write end lives on in the orphan and EOF never comes (the original `sh -c 'sleep 30
  //   & echo started'`).
  // - Windows: nothing observable can hold it there. Bun passes a child pipe handles it does not
  //   re-pass to a grandchild — the identical spawn answered `code: 0, timedOut: false` in 18 ms
  //   on windows-latest — and `start /b`, the scriptable background, points a child's stdio at
  //   the console instead of the pipe it was given. So the child holds the pipe itself by
  //   outliving the deadline; the kill seam records the same wall
  //   (`packages/cli/src/verify-deadline.ts`: Windows keeps no tag to find a re-parented
  //   grandchild).
  //
  // That left Windows with two same-deadline killers — `run()`'s own timer, and Bun's spawn
  // timeout, which kills the holder and so EOFs its pipes — and whichever won the race decided
  // the verdict's SHAPE (`timedOut` + no code, or a killed code): the `windows` CI job's
  // `unit · scripts/lib` step was red for it, and the shape flipped 1 in 15 on a Linux box,
  // 2026-10. `run()` now arms ONE killer — its own timer — so the coded verdict is deterministic
  // on every host, and the Windows branch asserts what POSIX asserted.
  //
  // One constant for that child, because the tests using it assert on its exact text — `run()`
  // echoes `command.join(' ')` into the timeout line.
  const HOLDS_STDOUT =
    process.platform === 'win32'
      ? 'console.log("started"); setTimeout(() => {}, 60_000);'
      : 'Bun.spawn(["bun","-e","setTimeout(()=>{},60000)"],{stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log("started");process.exit(0);';

  // The child the regression test below runs: it holds its OWN stdout — the shape that raced,
  // on every platform — and would exit 7 five seconds in, long past the deadline.
  const OUTLIVES_THE_DEADLINE = 'setTimeout(() => process.exit(7), 5_000);';

  test('stdout that never reaches EOF cannot hold the caller past the deadline', async () => {
    const started = performance.now();
    const result = await run(['bun', '-e', HOLDS_STDOUT], { cwd, timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(5_000);
    // Answered AT the deadline on both platforms: the holder hangs for a minute, so an answer
    // this early is the deadline speaking — never the 18 ms `ok: true` the old grandchild
    // fixture got on Windows.
    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
    // What the child DID print is kept: it is the clue to where it stopped.
    expect(result.output).toContain('started');
    // The coded verdict, on every platform: `run()` arms one killer, so the deadline decides
    // the shape (see the fixture comment).
    expect(result).toMatchObject({ ok: false, code: null, timedOut: true });
    // The coded line names the program that was killed, verbatim: `run()` echoes
    // `command.join(' ')`, so the reported command is the one that actually hung.
    expect(result.output).toContain(`${RUN_TIMEOUT_CODE}: bun -e ${HOLDS_STDOUT}`);
    expect(result.output).toContain('did not finish within 300 ms');
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

  // The regression this file's deadline shape rests on: a child that OUTLIVES the deadline
  // answers the coded timeout — `timedOut: true`, `code: null` — and never the child's own
  // exit code. Two killers on one deadline raced that verdict (`run()`'s timer and Bun's spawn
  // timeout) and the winner decided its shape per host; on `windows-latest` the spawn timeout
  // won, so the `windows` job's `unit · scripts/lib` step was red for it. One killer now, so
  // the shape is the coded timeout everywhere.
  test('a child that outlives the deadline answers the coded timeout, not its own exit code', async () => {
    const started = performance.now();
    const result = await run(['bun', '-e', OUTLIVES_THE_DEADLINE], { cwd, timeoutMs: 300 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    // Never the child's own exit code (7): a run killed at its deadline answers no code at all.
    expect(result.code).toBeNull();
    // The coded line is the answer, and it names the program that hung.
    expect(result.output).toContain(`${RUN_TIMEOUT_CODE}: bun -e ${OUTLIVES_THE_DEADLINE}`);
    expect(result.output).toContain('did not finish within 300 ms');
  });

  // The pipes are released, not only abandoned: a script whose `run()` timed out still exits,
  // rather than living until whatever holds its output does. The inner run's verdict travels
  // out as one JSON line, because the probe only proves something if it REACHES the deadline —
  // the Windows grandchild fixture used to answer `ok: true` in 18 ms and green this without
  // racing anything.
  test('the calling process exits after its timeout, not when the holder dies', async () => {
    const VERDICT = 'inner verdict ';
    const probe = `import { run } from ${JSON.stringify(join(import.meta.dir, 'run.ts'))};
const inner = await run(['bun', '-e', ${JSON.stringify(HOLDS_STDOUT)}], { cwd: ${JSON.stringify(cwd)}, timeoutMs: 200 });
console.log(${JSON.stringify(VERDICT)} + JSON.stringify({ code: inner.code, durationMs: inner.durationMs, ok: inner.ok, timedOut: inner.timedOut }));`;
    const outer = await run(['bun', '-e', probe], { cwd, timeoutMs: 10_000 });
    expect({ timedOut: outer.timedOut, ok: outer.ok }).toEqual({ timedOut: false, ok: true });
    const line = outer.output.split('\n').find((one) => one.startsWith(VERDICT));
    if (line === undefined) return expect.unreachable('the probe never reported the inner verdict');
    const inner = JSON.parse(line.slice(VERDICT.length)) as {
      code: number | null;
      durationMs: number;
      ok: boolean;
      timedOut: boolean;
    };
    // The inner run reached its deadline on both platforms — the holder hangs for a minute, so
    // only the deadline ends it — and answered refused, never the old Windows `ok: true`.
    expect(inner.ok).toBe(false);
    expect(inner.durationMs).toBeGreaterThanOrEqual(190);
    expect(inner.durationMs).toBeLessThan(10_000);
    // The coded verdict, on every platform: one killer, so the deadline decides the shape.
    expect(inner.timedOut).toBe(true);
    expect(inner.code).toBeNull();
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
