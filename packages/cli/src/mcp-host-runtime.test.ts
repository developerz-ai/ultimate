// `x mcp serve` boots the app's services on first use — with the app's `runtime.ts`, as `x dev`
// does: a KMS-keyed app's dev server asked the env/file key, and ran on the system clock.

import { afterAll, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ambientClock } from '@ultimat3/core';
import { tempTrees } from '@ultimat3/testing';
import type { Runner } from './exec';
import { lazyServices } from './mcp-host';

// Under this package's ignored `.x/fixtures/`: a child resolves `@ultimat3/*` from the workspace.
const trees = tempTrees({ inPackage: join(import.meta.dir, '..') });
afterAll(() => trees.dispose());

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
  const root = trees.make('mcp-runtime-fixture-');
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
