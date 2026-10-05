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
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './run';
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
