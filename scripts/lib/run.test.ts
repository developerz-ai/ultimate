// The scripts' one subprocess boundary. The guard it throws is the same guard
// `packages/cli/src/exec.ts` makes at the same seam, and for the same reason — it used to be a
// bare `RangeError`: no code, no `fix:`, nothing a `--json` reader can act on.

import { describe, expect, test } from 'bun:test';
import { repoRoot, run } from './run';
import { ScriptError } from './script-error';

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
  });
});
