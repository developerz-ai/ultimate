// A production process signing with the development key the framework ships is refused at boot,
// before a single service starts. `x doctor` reported it and nothing failed — so a pod that forgot
// ULTIMATE_CURSOR_SECRET signed every cursor with a key published in `@ultimat3/core`.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the root must exist and be empty so nothing booted is visible.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { usesDevCursorSecret } from '@ultimat3/core';
import { serveApp } from './serve';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** Records a directory `mkdtemp` made, for the removal above. */
const made = (dir: string): string => {
  madeDirs.push(dir);
  return dir;
};

test('a production boot on the shipped cursor key is refused before any service starts', async () => {
  // The precondition, asserted: this process really is on the development key.
  expect(usesDevCursorSecret()).toBe(true);
  const root = made(mkdtempSync(join(tmpdir(), 'serve-secrets-')));
  const outcome = await serveApp({ root, env: { ULTIMATE_ENV: 'production' }, role: 'web' }).then(
    () => 'booted',
    (error: unknown) => (error as { code?: string }).code ?? 'uncoded',
  );
  expect(outcome).toBe('X_CURSOR_SECRET_DEV');
  // Nothing was started: no embedded state directory, no database, no listener.
  expect(existsSync(join(root, '.x'))).toBe(false);
});
