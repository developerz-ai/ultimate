// Failure first: the case that shipped a zero-entity manifest is the global CLI running inside an
// app that has its own — that must resolve to the app's file, and nothing else may.

import { describe, expect, test } from 'bun:test';
// why: a real `realpathSync` on a virtual path is what throws the ENOENT the compiled case rests on.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
// why: Bun ships no temp-directory primitive.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { KEEP_GLOBAL_CLI_ENV, LOCAL_CLI_BIN, type LocalCliIo, resolveLocalCli } from './local-cli';

const app = () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-local-cli-'));
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
};

const io = (existing: readonly string[], real: (p: string) => string = (p) => p): LocalCliIo => ({
  exists: (path) => existing.includes(path),
  realpath: real,
});

describe('resolveLocalCli', () => {
  test('a global CLI inside an app that has its own defers to the app copy', () => {
    const dir = app();
    const local = join(dir, LOCAL_CLI_BIN);
    expect(
      resolveLocalCli(
        { cwd: dir, selfPath: '/home/u/.bun/global/cli/src/bin.ts', env: {} },
        io([local]),
      ),
    ).toBe(local);
  });

  test('the app copy itself, reached through a workspace symlink, does not re-exec forever', () => {
    const dir = app();
    const local = join(dir, LOCAL_CLI_BIN);
    const checkout = '/checkout/packages/cli/src/bin.ts';
    const same = io([local], (p) => (p === local ? checkout : p));
    expect(resolveLocalCli({ cwd: dir, selfPath: checkout, env: {} }, same)).toBeUndefined();
  });

  test('no app, or no local install, keeps the CLI that was invoked', () => {
    expect(resolveLocalCli({ cwd: tmpdir(), selfPath: '/x', env: {} }, io([]))).toBeUndefined();
    const dir = app();
    expect(resolveLocalCli({ cwd: dir, selfPath: '/x', env: {} }, io([]))).toBeUndefined();
  });

  test('a compiled binary keeps itself: its own path is not a file realpath can resolve', () => {
    const dir = app();
    const local = join(dir, LOCAL_CLI_BIN);
    // The real `realpathSync` on the virtual path, so the throw is the filesystem's own ENOENT.
    const bunfs = '/$bunfs/root/x';
    const compiled = io([local], (p) => (p === bunfs ? realpathSync(p) : p));
    expect(resolveLocalCli({ cwd: dir, selfPath: bunfs, env: {} }, compiled)).toBeUndefined();
  });

  // Through the REAL filesystem, once: the reference app's `node_modules/@ultimat3/cli` is a
  // workspace symlink to `packages/cli`, so this checkout's own `bin.ts` is the same file — the
  // case every CI run and both tracked apps sit in, and the one that must never hand over.
  test('this checkout inside its own reference app resolves to the same file, over the real fs', () => {
    const checkout = join(import.meta.dir, '..', '..', '..');
    const dummy = join(checkout, 'examples', 'dummy');
    const self = join(checkout, 'packages', 'cli', 'src', 'bin.ts');
    expect(resolveLocalCli({ cwd: dummy, selfPath: self, env: {} })).toBeUndefined();
    // And a DIFFERENT real file — any other module of this checkout stands in for a global copy —
    // is handed over to the app's own bin over the same real fs.
    const foreign = join(checkout, 'packages', 'cli', 'src', 'dispatch.ts');
    expect(resolveLocalCli({ cwd: dummy, selfPath: foreign, env: {} })).toBe(
      join(dummy, LOCAL_CLI_BIN),
    );
  });

  test('the escape hatch keeps the global one on purpose', () => {
    const dir = app();
    const local = join(dir, LOCAL_CLI_BIN);
    expect(
      resolveLocalCli(
        { cwd: dir, selfPath: '/x', env: { [KEEP_GLOBAL_CLI_ENV]: '1' } },
        io([local]),
      ),
    ).toBeUndefined();
  });
});
