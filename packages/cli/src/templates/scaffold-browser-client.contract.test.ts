// The emitted `browser-client.test.ts`, RUN: a template is a string, and a test nobody executed
// has said nothing about whether a new app's first `x verify` is green. Both variants, one `bun
// test` process, in a sandbox that borrows the workspace's installed packages.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no API for a directory, a temporary one or a symlink (`mkdirSync`, `mkdtempSync`, `symlinkSync`).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path joiner; `Bun.write` and `Bun.spawn` take a path already joined.
import { join, resolve } from 'node:path';
import { browserClientFiles } from './scaffold-browser-client';

const ROOT = resolve(import.meta.dir, '../../../..');
const dir = mkdtempSync(join(tmpdir(), 'x-browser-client-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runEmitted(): Promise<{ readonly exitCode: number; readonly output: string }> {
  // The three packages the emitted files import, as an installed app sees them: a directory under
  // `node_modules/@ultimat3`. Each resolves its own dependencies from where it really lives.
  mkdirSync(join(dir, 'node_modules', '@ultimat3'), { recursive: true });
  for (const name of ['action', 'query', 'testing']) {
    symlinkSync(join(ROOT, 'packages', name), join(dir, 'node_modules', '@ultimat3', name), 'dir');
  }
  for (const example of [false, true]) {
    for (const file of browserClientFiles(example)) {
      await Bun.write(join(dir, example ? 'example' : 'bare', file.path), file.contents);
    }
  }
  const run = Bun.spawn(['bun', 'test', './bare', './example'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

describe('contract · the scaffolded browser-client test passes as written', () => {
  test('one action call per variant and the example read, on the wire', async () => {
    const { exitCode, output } = await runEmitted();
    // The output first: a red run then prints the emitted test's own failure, not just a code.
    expect(output).toContain(' 3 pass');
    expect(output).toContain(' 0 fail');
    // `bun test` exits 1 on an error BETWEEN tests while still printing `0 fail`.
    expect(exitCode).toBe(0);
  }, 60_000);
});
