// The e2e step's wrapper, on the path a unit test can take without a browser or an app: a root that
// is not an app runs the suite exactly as given — no preload, no base url, nothing spawned.

import { expect, test } from 'bun:test';
import { e2eBrowser } from './e2e-browser-handle';
import type { ExecResult } from './exec';
import { E2E_PRELOAD, withE2eApp } from './verify-e2e';

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
  expect(seen[0]?.command).not.toContain(E2E_PRELOAD);
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
