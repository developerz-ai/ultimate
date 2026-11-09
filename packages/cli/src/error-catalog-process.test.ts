// The catalog as an installed `x` process sees it: no test preload, so no render loader unless the
// catalog installs one. The in-process suite cannot tell — `scripts/test-setup.ts` installs it for
// every test file, which is exactly how `x errors` shipped unable to load `@ultimat3/admin`.

import { describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun exposes no path-join primitive.
import { join } from 'node:path';

const BIN = join(import.meta.dir, 'bin.ts');

const run = async (...args: string[]): Promise<{ exit: number; out: string; err: string }> => {
  // `bun <file>` reads no `[test]` preload: the child is the bare CLI an adopter runs.
  const child = Bun.spawn(['bun', BIN, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit: await child.exited, out, err };
};

describe('process · x errors without the test preload', () => {
  test('explains a code owned by a `.tsx` package (admin)', async () => {
    const { exit, out, err } = await run('errors', 'explain', 'X_ADMIN_INVALID', '--json');
    expect({ exit, ok: JSON.parse(out).ok, err }).toEqual({ exit: 0, ok: true, err: '' });
  }, 30_000);

  test('lists every package with nothing failed to initialize', async () => {
    const { exit, out } = await run('errors', 'list', '--json');
    const doc: unknown = JSON.parse(out);
    expect({ exit, doc }).toMatchObject({ exit: 0, doc: { ok: true } });
    expect(JSON.stringify(doc)).not.toContain('failed to initialize');
  }, 30_000);
});
