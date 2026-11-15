// The REAL `e2e` gate step, not `judgeE2eBrowser` alone: a fixture app that floors `e2e`, on an
// environment whose `CHROME_PATH` names a missing file (so `findChrome` answers none without
// probing any candidate), whose suite ran nothing — red with the browser code and its install fix.

import { afterAll, beforeAll, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import type { Runner } from './exec';
import { browserInstallCommand, E2E_BROWSER_MISSING } from './verify-e2e';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { resetTestDiscovery, TEST_STEPS } from './verify-tests';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-verify-e2e-wired-'));
  await Bun.write(join(root, APP_CONFIG_FILE), 'export const config = {};\n');
  await Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps: ['e2e'] }));
  await Bun.write(
    join(root, 'apps/web/e2e/home.e2e.test.ts'),
    '// the suite the runner stands in for\n',
  );
});

afterAll(async () => {
  resetTestDiscovery();
  await rm(root, { recursive: true, force: true });
});

/** `bun test`'s own summary for a suite whose every test skipped itself. */
const allSkipped: Runner = async (command) => ({
  command,
  code: 0,
  ok: true,
  stdout: '',
  stderr: ' 0 pass\n 3 skip\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n',
  durationMs: 5,
});

test('the e2e step of a floored app with no browser is red with the install command', async () => {
  const step = TEST_STEPS.find((candidate) => candidate.name === 'e2e');
  expect(step).toBeDefined();
  resetTestDiscovery();
  const ctx = {
    root,
    runner: allSkipped,
    env: { ...Bun.env, CHROME_PATH: join(root, 'no-such-chrome') },
  };
  expect(await step?.applies?.(ctx)).toBe(true);
  const outcome = await step?.run(ctx);
  expect(outcome?.tests).toEqual({ ran: 0, skipped: 3 });
  expect(outcome?.ok).toBe(false);
  expect(outcome?.findings[0]?.code).toBe(E2E_BROWSER_MISSING);
  expect(outcome?.findings[0]?.fix.startsWith(browserInstallCommand(process.platform))).toBe(true);
});
