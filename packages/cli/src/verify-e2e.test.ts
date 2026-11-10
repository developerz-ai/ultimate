// The e2e step's wrapper, on the path a unit test can take without a browser or an app: a root that
// is not an app runs the suite exactly as given — no preload, no base url, nothing spawned.

import { expect, test } from 'bun:test';
import { e2eBrowser } from '@ultimat3/testing';
import type { ExecResult } from './exec';
import { appE2eRun, E2E_TIME_ZONE, e2ePreload, withE2eApp } from './verify-e2e';

const ok: ExecResult = { command: [], code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };

test('not an app: the suite runs as given, with no preload and no spawned app', async () => {
  const seen: { command: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] =
    [];
  await withE2eApp(
    { root: '/nonexistent', isApp: false, command: ['bun', 'test', 'e2e/'], env: {} },
    async (run) => {
      seen.push(run);
      return ok;
    },
  );

  expect(seen).toEqual([{ command: ['bun', 'test', 'e2e/'], env: {} }]);
  expect(seen[0]?.command).not.toContain(e2ePreload());
});

test('an app e2e invocation has one explicit non-UTC zone before its preload opens a browser', () => {
  const run = appE2eRun({
    root: '/app',
    command: ['bun', 'test', 'e2e/'],
    env: { KEPT: 'yes', TZ: 'UTC' },
  });

  expect(run.command).toEqual(['bun', 'test', '--preload', e2ePreload(), 'e2e/']);
  expect(run.env).toEqual({
    KEPT: 'yes',
    TZ: E2E_TIME_ZONE,
    ULTIMATE_E2E_ROOT: '/app',
  });
  expect(E2E_TIME_ZONE).not.toBe('UTC');
});

test('e2eBrowser() outside an e2e run refuses by name rather than answering undefined', () => {
  const thrown = (() => {
    try {
      return e2eBrowser();
    } catch (error) {
      return error;
    }
  })();
  expect(thrown).toBeUltimateError('X_CDP_BROWSER_MISSING');
});
