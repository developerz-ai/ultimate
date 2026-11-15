// The e2e step's wrapper, on the path a unit test can take without a browser or an app: a root that
// is not an app runs the suite exactly as given — no preload, no base url, nothing spawned.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { e2eBrowser } from '@ultimat3/testing';
import type { ExecResult } from './exec';
import {
  appE2eRun,
  browserInstallCommand,
  E2E_BROWSER_MISSING,
  E2E_TIME_ZONE,
  e2ePreload,
  judgeE2eBrowser,
  withE2eApp,
} from './verify-e2e';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import type { StepOutcome } from './verify-step';

const ok: ExecResult = { command: [], code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };

test('not an app: the suite runs as given, with no preload and no spawned app', async () => {
  const seen: { command: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] =
    [];
  await withE2eApp(
    { root: '/nonexistent', isApp: false, command: ['bun', 'test', 'e2e/'], env: {}, hostEnv: {} },
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

// G2: `e2e` in the floor, an app, and no browser on this machine — the suite ran nothing because
// every browser-backed test skipped, and the step says so with the command that installs one.
describe('a floored e2e step on a machine with no browser', () => {
  let root = '';
  const noChrome = { CHROME_PATH: '/nonexistent/chrome-for-the-test' };
  const allSkipped: StepOutcome = {
    ok: true,
    findings: [],
    workers: 1,
    tests: { ran: 0, skipped: 3 },
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'x-verify-e2e-browser-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const floor = (steps: readonly string[]) =>
    Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps }));

  test('is red with the browser code first, and its fix installs a browser', async () => {
    await floor(['unit', 'e2e']);
    const judged = await judgeE2eBrowser({
      root,
      isApp: true,
      outcome: allSkipped,
      env: noChrome,
      platform: 'linux',
    });
    expect(judged.ok).toBe(false);
    expect(judged.findings[0]?.code).toBe(E2E_BROWSER_MISSING);
    expect(judged.findings[0]?.fix.startsWith(browserInstallCommand('linux'))).toBe(true);
    expect(judged.findings[0]?.fix).toContain('CHROME_PATH=');
    expect(judged.findings[0]?.cause).toContain('/nonexistent/chrome-for-the-test');
    // The counts stay: the step table still says what ran.
    expect(judged.tests).toEqual({ ran: 0, skipped: 3 });
  });

  test('each platform installs with its own package manager, command first', () => {
    expect(browserInstallCommand('linux')).toBe(
      'curl -fsSLo /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y /tmp/google-chrome.deb',
    );
    expect(browserInstallCommand('darwin')).toBe('brew install --cask google-chrome');
    expect(browserInstallCommand('win32')).toBe('winget install --id Google.Chrome -e');
  });

  test('not floored, not an app, or something ran: the outcome is untouched', async () => {
    await floor(['unit']);
    const input = { root, isApp: true, outcome: allSkipped, env: noChrome, platform: 'linux' };
    expect(await judgeE2eBrowser(input)).toBe(allSkipped);
    await floor(['e2e']);
    expect(await judgeE2eBrowser({ ...input, isApp: false })).toBe(allSkipped);
    const ran: StepOutcome = { ...allSkipped, tests: { ran: 2, skipped: 1 } };
    expect(await judgeE2eBrowser({ ...input, outcome: ran })).toBe(ran);
  });
});

test("an app's launch decision reads the step's own environment: a missing CHROME_PATH there is no browser", async () => {
  const seen: (readonly string[])[] = [];
  await withE2eApp(
    {
      root: '/app',
      isApp: true,
      command: ['bun', 'test', 'e2e/'],
      env: {},
      hostEnv: { CHROME_PATH: '/nonexistent/chrome-for-the-launch' },
    },
    async (run) => {
      seen.push(run.command);
      return ok;
    },
  );
  // No browser found, so no preload: the suite runs as given.
  expect(seen).toEqual([['bun', 'test', 'e2e/']]);
});
