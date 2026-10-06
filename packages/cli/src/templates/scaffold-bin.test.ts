// The two scripts a scaffolded app runs through `bun run`, held to their one promise: the same
// behaviour on every OS, which means no shell anywhere in them. Each is EXECUTED here against a
// stand-in `x` that records its argv, so a dropped step, a lost `--json` or a swallowed exit code
// is a failing assertion rather than something a newcomer meets on PowerShell.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case writes a throwaway app.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive, and the scripts are spawned by their joined path.
import { join } from 'node:path';
import { BIN_SCRIPTS, binFiles } from './scaffold-bin';

const source = (path: string): string => {
  const file = binFiles().find((entry) => entry.path === path);
  if (file === undefined) return expect.unreachable(`binFiles() writes no ${path}`);
  return typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * An app root with both scripts, a `package.json` with no dependencies (so the real `bun install`
 * resolves nothing and touches no network) and a stand-in `node_modules/.bin/x` that appends its argv to
 * `x.log` — exiting with `X_EXIT` when its first argument is `X_FAIL_ON`.
 */
const appRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-bin-'));
  dirs.push(root);
  for (const file of binFiles()) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, file.path), file.contents);
  }
  // `postinstall` is the observable proof the real `bun install` ran from the app root.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'bin-probe',
      private: true,
      scripts: { postinstall: 'echo installed > installed.txt' },
    }),
  );
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'x'),
    [
      '#!/usr/bin/env bun',
      "import { appendFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(join(root, 'x.log'))}, args.join(' ') + '\\n');`,
      "if (args[0] === process.env.X_FAIL_ON) process.exit(Number(process.env.X_EXIT ?? '1'));",
    ].join('\n'),
  );
  chmodSync(join(bin, 'x'), 0o755);
  return root;
};

/**
 * One bin script's deadline. A script spawns `bun` for itself and once per `x` call it makes, so on a
 * loaded runner one test outlives bun's default 5 s — the deadline below fired second, the test's
 * own first (seen in CI, `--json reaches BOTH halves`). The test budget is DERIVED from it.
 */
const SCRIPT_DEADLINE_MS = 30_000;
setDefaultTimeout(SCRIPT_DEADLINE_MS + 5_000);

const runScript = (
  root: string,
  path: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): { readonly code: number; readonly calls: readonly string[] } => {
  const run = Bun.spawnSync([process.execPath, join(root, path), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    // A bin script runs a stand-in `x` and exits; one that hangs fails the test instead of the run.
    timeout: SCRIPT_DEADLINE_MS,
  });
  const log = join(root, 'x.log');
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: run.exitCode, calls };
};

describe('unit · the bin scripts are TypeScript, never shell', () => {
  test('exactly the two files package.json runs, with no shebang and no shell syntax', () => {
    expect(binFiles().map((file) => file.path)).toEqual([BIN_SCRIPTS.setup, BIN_SCRIPTS.check]);
    for (const path of Object.values(BIN_SCRIPTS)) {
      const text = source(path);
      expect({ path, shebang: text.startsWith('#!') }).toEqual({ path, shebang: false });
      for (const bashism of ['set -e', '$(', '"$@"', '/dev/null', 'exec ', '#!/usr/bin/env bash']) {
        expect({ path, bashism, found: text.includes(bashism) }).toEqual({
          path,
          bashism,
          found: false,
        });
      }
    }
  });
});

// A stand-in `x` is a shebang file, which only POSIX execs; on Windows `bun install` would need a
// `.exe` shim in its place. The scripts themselves are what the Windows CI job runs for real.
describe.skipIf(process.platform === 'win32')('unit · bin/check.ts, executed', () => {
  test('builds, then verifies, from the app root whatever the caller’s cwd', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.check);
    expect(run.code).toBe(0);
    expect(run.calls).toEqual(['build --target static --no-preflight', 'verify']);
  });

  test('--json reaches BOTH halves, and every argument reaches the gate', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.check, ['--json', '--full']);
    expect(run.calls).toEqual([
      'build --target static --no-preflight --json',
      'verify --json --full',
    ]);
  });

  test('a red build stops the gate and is the exit code', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.check, [], { X_FAIL_ON: 'build', X_EXIT: '3' });
    expect(run.code).toBe(3);
    expect(run.calls).toEqual(['build --target static --no-preflight']);
  });

  test('a red gate is the exit code', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.check, [], { X_FAIL_ON: 'verify', X_EXIT: '4' });
    expect(run.code).toBe(4);
  });
});

describe.skipIf(process.platform === 'win32')('unit · bin/setup.ts, executed', () => {
  test('installs, writes the per-box env file, generates, migrates, seeds, writes the manifest', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.setup, ['--yes']);
    expect(run.code).toBe(0);
    expect(existsSync(join(root, 'installed.txt'))).toBe(true);
    expect(Bun.file(join(root, '.env.development.local')).size).toBeGreaterThan(0);
    expect(run.calls).toEqual(['db gen initial', 'db migrate --yes', 'db seed', 'manifest']);
  });

  test('idempotent: an existing migration and env file are left alone', () => {
    const root = appRoot();
    mkdirSync(join(root, 'packages', 'db', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'packages', 'db', 'migrations', '0001_initial.sql'), 'select 1;\n');
    writeFileSync(join(root, '.env.development.local'), 'SECRET=mine\n');
    const run = runScript(root, BIN_SCRIPTS.setup);
    expect(run.code).toBe(0);
    expect(run.calls).toEqual(['db migrate', 'db seed', 'manifest']);
    expect(readFileSync(join(root, '.env.development.local'), 'utf8')).toBe('SECRET=mine\n');
  });

  test('a red step stops setup with its exit code', () => {
    const root = appRoot();
    const run = runScript(root, BIN_SCRIPTS.setup, [], { X_FAIL_ON: 'db', X_EXIT: '5' });
    expect(run.code).toBe(5);
    expect(run.calls).toEqual(['db gen initial']);
  });
});
