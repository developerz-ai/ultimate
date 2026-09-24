// The spawner's refusal path, which is the half a unit test can pin: a root that is not an app
// fails at its reset with the reset's own output in the cause — and neither the throwaway state
// directory nor the root's own `.x` is left behind.

import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join, resolve } from 'node:path';
import { startE2eApp } from './e2e-app';

const throwaways = (): readonly string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('ultimate-e2e-'));

test('a root that is not an app is X_E2E_APP_FAILED, and nothing is left on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'x-e2e-app-root-'));
  // Not an app, but one that installed the CLI — so the refusal is the reset's, not the resolve's.
  mkdirSync(join(root, 'node_modules/@ultimat3'), { recursive: true });
  symlinkSync(resolve(import.meta.dir, '../../cli'), join(root, 'node_modules/@ultimat3/cli'));
  const before = new Set(throwaways());
  try {
    const error = await startE2eApp({ root, readyTimeoutMs: 1_000 }).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_E2E_APP_FAILED');
    expect((error as { cause: string }).cause).toContain('x db reset');
    // The state directory was a throwaway, and it is gone; the root never grew a `.x` of its own.
    expect(throwaways().filter((name) => !before.has(name))).toEqual([]);
    expect(existsSync(join(root, '.x'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a readiness budget that is not a finite count is refused before anything spawns', async () => {
  const before = new Set(throwaways());
  const error = await startE2eApp({ root: tmpdir(), readyTimeoutMs: Number.NaN }).catch(
    (e: unknown) => e,
  );
  // Refused by name — `waited < NaN` is false, so a NaN budget would report every app as dead.
  expect((error as { code?: string }).code).toMatch(/^X_/);
  expect((error as { code?: string }).code).not.toBe('X_E2E_APP_FAILED');
  expect(throwaways().filter((name) => !before.has(name))).toEqual([]);
});
