// Compiles a real single-file executable and runs it. That is the whole point: `x build --target
// binary` shipped broken for two releases because nothing ever executed the artifact — it compiled,
// so the gate was green, and then it threw at import on the first machine that ran it.
//
//   bun test packages/core/e2e
//
// What only a compiled binary can prove: `import.meta.dir` becomes `/$bunfs/root` and the package
// manifest is simply not there, so the version has to come from the build define — and when it
// does not, the process still fails loudly rather than reporting `undefined`.

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION_DEFINE } from '../src/version';

const dir = mkdtempSync(join(tmpdir(), 'ultimate-version-e2e-'));
const entry = join(dir, 'entry.ts');
const module = join(import.meta.dir, '..', 'src', 'version.ts');
const DEFINED = '9.9.9-binary';

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

await Bun.write(
  entry,
  `import { frameworkVersion } from ${JSON.stringify(module)};\nconsole.log(frameworkVersion());\n`,
);

/** Compile `entry.ts` to a standalone executable, run it, and report what the process did. */
async function compileAndRun(
  name: string,
  define: string | undefined,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const out = join(dir, name);
  const build = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      ...(define === undefined ? [] : ['--define', define]),
      entry,
      '--outfile',
      out,
    ],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  );
  // The compiler's own diagnostic, or a failed compile reports `1 !== 0` and nothing actionable.
  const [buildErr, buildCode] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(buildCode, buildErr).toBe(0);
  const run = Bun.spawn([out], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code, stdout, stderr };
}

test('a compiled binary boots and reports the version the build defined', async () => {
  const result = await compileAndRun('with-define', `${VERSION_DEFINE}=${JSON.stringify(DEFINED)}`);
  expect(result.stderr).not.toContain('X_INVARIANT');
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(DEFINED);
}, 60_000);

test('a binary compiled without the define fails loudly, with the command that adds it', async () => {
  const result = await compileAndRun('no-define', undefined);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('X_INVARIANT');
  expect(result.stderr).toContain(VERSION_DEFINE);
  expect(result.stderr).toContain('x build --target binary');
}, 60_000);
