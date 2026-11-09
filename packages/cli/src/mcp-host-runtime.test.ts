// `x mcp serve` boots the app's services on first use — with the app's `runtime.ts`, as `x dev`
// does: a KMS-keyed app's dev server asked the env/file key, and ran on the system clock.

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ambientClock } from '@ultimat3/core';
import type { Runner } from './exec';
import { lazyServices } from './mcp-host';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noRunner: Runner = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

test("the lazy boot honours runtime.ts: its clock while running, the system's after", async () => {
  // Inside this package, so the fixture's `@ultimat3/core` import resolves.
  const root = mkdtempSync(join(import.meta.dir, '..', '.mcp-runtime-fixture-'));
  dirs.push(root);
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'mcp-runtime' };\n");
  await Bun.write(
    join(root, 'apps/web/runtime.ts'),
    "import { frozenClock } from '@ultimat3/core';\nexport const runtime = { clock: frozenClock('2031-01-02T03:04:05Z') };\n",
  );
  const lazy = lazyServices({ root, env: { ULTIMATE_ENV: 'development' }, runner: noRunner });
  try {
    await lazy.running();
    expect(ambientClock().now().toISOString()).toBe('2031-01-02T03:04:05.000Z');
  } finally {
    await lazy.close();
  }
  expect(ambientClock().now().getUTCFullYear()).not.toBe(2031);
}, 60_000);
