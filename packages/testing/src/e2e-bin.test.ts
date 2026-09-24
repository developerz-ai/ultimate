// The e2e app is spawned through the `x` CLI, which lives in `@ultimat3/cli` — not in this package.
// The path was `import.meta.dir/bin.ts` while the driver lived in cli, and moving the driver here
// left it pointing at a file that does not exist: every app's e2e file failed X_E2E_APP_FAILED.
import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join, resolve } from 'node:path';
import { startE2eApp } from './e2e-app';
import { xBin } from './e2e-spawn';

const REPO = resolve(import.meta.dir, '../../..');

test("an app's e2e run spawns the cli's own bin, resolved from the app root", async () => {
  const bin = await xBin(join(REPO, 'examples/dummy'));
  expect(existsSync(bin)).toBe(true);
  expect(bin).toBe(join(REPO, 'packages/cli/src/bin.ts'));
});

test('a root that cannot resolve @ultimat3/cli is refused by name, before any state exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'x-e2e-bin-'));
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('ultimate-e2e-')));
  try {
    const error = await startE2eApp({ root, readyTimeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_E2E_APP_FAILED');
    expect((error as { cause: string }).cause).toContain('resolve @ultimat3/cli');
    expect((error as { fix: string }).fix).toStartWith('bun add -d @ultimat3/cli');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('ultimate-e2e-'));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
