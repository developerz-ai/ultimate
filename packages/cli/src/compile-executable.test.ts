// `compileExecutable`'s refusal, without a compile: an entry Bun cannot build is `X_BUILD_FAILED`
// naming the entry, the outfile and Bun's own log. The successful compile is the boot e2e's
// (`e2e/binary-launch.e2e.test.ts`) — a whole executable is seconds a unit suite should not pay.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { compileExecutable } from './compile-executable';
import { ExecutableCompileFailedError } from './errors';

const dir = mkdtempSync(join(tmpdir(), 'x-compile-executable-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('compileExecutable', () => {
  test('an entry that does not build is X_BUILD_FAILED, naming both paths and the log', async () => {
    const entry = join(dir, 'broken.ts');
    const outfile = join(dir, 'x-out');
    await Bun.write(entry, "import { nothing } from './no-such-module';\nconsole.log(nothing);\n");

    const thrown = await compileExecutable({ entry, outfile, define: { FLAG: '"1"' } }).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(thrown instanceof ExecutableCompileFailedError)) {
      expect.unreachable('a broken entry compiled, or failed with something other than the code');
    }
    expect(thrown.code).toBe('X_BUILD_FAILED');
    expect(thrown.cause).toContain(entry);
    expect(thrown.cause).toContain(outfile);
    // Bun's own resolution message, not a paraphrase: the log is what the reader acts on.
    expect(thrown.cause).toContain('no-such-module');
    expect(await Bun.file(outfile).exists()).toBe(false);
  });
});
