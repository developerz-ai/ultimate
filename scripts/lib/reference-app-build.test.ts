// The build half of the reference-app gate: stale outputs cleared, the static build run in the app,
// and a failed build reported as the app's regression rather than swallowed into a red `budgets`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs'; // why: Bun has no temp-directory native; the fixture needs a real app root on disk.
import { rm } from 'node:fs/promises'; // why: Bun.file().delete() removes one file, never a tree.
import { tmpdir } from 'node:os'; // why: the fixture's temp root, which Bun exposes no native for.
import { join } from 'node:path'; // why: host-separator paths into the fixture root; Bun ships no path API.
import type { ExecResult } from '@ultimat3/cli';
import { appWith } from '../reference-app-gate.fixtures';
import { buildApp, STALE_BUILD_OUTPUTS } from './reference-app-build';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const repoWith = async (dir: string): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'app-build-'));
  roots.push(root);
  await Bun.write(join(root, dir, '.x/static/index.html'), '<p>stale</p>');
  await Bun.write(join(root, dir, '.x/static-report.json'), '{}');
  await Bun.write(join(root, dir, '.x/build-stats.json'), '{}');
  await Bun.write(join(root, dir, '.x/pgdata/keep'), 'the database is not a build output');
  return root;
};

const result = (command: readonly string[], ok: boolean, stdout = ''): ExecResult => ({
  command,
  code: ok ? 0 : 1,
  ok,
  stdout,
  stderr: ok ? '' : 'X_BUILD_FAILED: the island did not bundle',
  durationMs: 0,
});

describe('buildApp', () => {
  test('clears every stale build output, keeps the rest of .x/, then builds in the app', async () => {
    const dir = 'examples/dummy';
    const root = await repoWith(dir);
    const seen: { command: readonly string[]; cwd: string; stale: boolean[] }[] = [];
    const runner = async (command: readonly string[], options: { cwd: string }) => {
      const stale = await Promise.all(
        STALE_BUILD_OUTPUTS.map((path) => Bun.file(join(root, dir, path)).exists()),
      );
      seen.push({ command, cwd: options.cwd, stale });
      return result(command, true);
    };

    const finding = await buildApp(root, runner, appWith({}, dir));

    expect(finding).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe(join(root, dir));
    expect(seen[0]?.command).toEqual([
      'bun',
      'run',
      join(root, 'packages/cli/src/bin.ts'),
      'build',
      '--target',
      'static',
    ]);
    // Gone BEFORE the build ran — a stale report is exactly what made local runs differ from CI.
    expect(seen[0]?.stale).toEqual(STALE_BUILD_OUTPUTS.map(() => false));
    expect(await Bun.file(join(root, dir, '.x/static/index.html')).exists()).toBe(false);
    expect(await Bun.file(join(root, dir, '.x/pgdata/keep')).exists()).toBe(true);
  });

  test('a failed build is the app regressing, carrying the build’s own output', async () => {
    const dir = 'dummy/social-media-clone';
    const root = await repoWith(dir);
    const runner = async (command: readonly string[]) => result(command, false, 'building…');

    const finding = await buildApp(root, runner, appWith({}, dir));

    expect(finding?.code).toBe('X_REFERENCE_APP_REGRESSED');
    expect(finding?.at).toBe(dir);
    expect(finding?.cause).toContain('x build --target static');
    expect(finding?.cause).toContain('X_BUILD_FAILED');
    expect(finding?.fix).toBe(
      'cd dummy/social-media-clone && bun run ../../packages/cli/src/bin.ts build --target static',
    );
  });
});
