// `startsChrome`: whether a candidate is a browser this machine can start. What the CI log of #1033
// showed is pinned here: on Windows `chrome.exe --version` never exits (30 s × the run's timeout),
// and a probe with no deadline of its own waits on whatever holds its stdout.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake candidate; Bun has no mkdtemp or chmod.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the scratch paths.
import { join } from 'node:path';
import { chromeCandidates } from './cdp-launch-candidates';
import {
  CHROME_PROBE_TIMEOUT_MS,
  chromeProbeTestMs,
  findChromeTestMs,
  startsChrome,
} from './cdp-launch-probe';

/** The fakes are `#!/bin/sh` scripts, which Windows does not run. */
const WINDOWS = process.platform === 'win32';

const scratch = await mkdtemp(join(tmpdir(), 'x-chrome-probe-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

let made = 0;
const fake = async (body: string): Promise<string> => {
  made += 1;
  const path = join(scratch, `candidate-${String(made)}`);
  await Bun.write(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

/** Far below the probe's own 15 s, and far above a `sh` that exits at once. */
const SHORT_MS = 300;

describe('startsChrome', () => {
  test(
    'on Windows the candidate is never run: `chrome.exe --version` opens a browser and never exits',
    async () => {
      // A candidate that would fail the probe everywhere else. On win32 existence is the answer —
      // `findChrome` checked it — because running it was the 15 s × 2 that timed out every Windows run.
      const marker = join(scratch, 'ran-on-win32');
      const dead = await fake(`touch '${marker}'\nexit 1`);
      expect(await startsChrome(dead, 'win32')).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    chromeProbeTestMs(0),
  );

  test.skipIf(WINDOWS)(
    'elsewhere the same candidate is run, and refused',
    async () => {
      const dead = await fake('exit 1');
      expect(await startsChrome(dead, 'linux')).toBe(false);
    },
    chromeProbeTestMs(1),
  );

  test.skipIf(WINDOWS)(
    'a candidate that never exits is refused at the deadline',
    async () => {
      const hung = await fake('exec sleep 30');
      const began = performance.now();
      expect(await startsChrome(hung, 'linux', SHORT_MS)).toBe(false);
      expect(performance.now() - began).toBeLessThan(5_000);
    },
    chromeProbeTestMs(1, SHORT_MS),
  );

  test.skipIf(WINDOWS)(
    'one that exits but leaves its stdout held open is not waited on',
    async () => {
      // A grandchild inherits the pipe: the child's exit is not the banner's EOF. Waiting for the
      // text with no deadline was the same hang one process removed.
      const holder = await fake('sleep 3 &\necho "Google Chrome 120.0.6099.109"\nexit 0');
      const began = performance.now();
      expect(await startsChrome(holder, 'linux', SHORT_MS)).toBe(false);
      expect(performance.now() - began).toBeLessThan(2_500);
    },
    chromeProbeTestMs(1, SHORT_MS),
  );

  test.skipIf(WINDOWS)(
    'a bannering browser and a silent clean exit are both a browser',
    async () => {
      expect(await startsChrome(await fake('echo "Chromium 131.0.6778.85"'), 'linux')).toBe(true);
      expect(await startsChrome(await fake('exit 0'), 'linux')).toBe(true);
    },
    chromeProbeTestMs(2),
  );

  test.skipIf(WINDOWS)(
    'a banner naming no browser is not one',
    async () => {
      expect(await startsChrome(await fake('echo "1.4.4"'), 'linux')).toBe(false);
    },
    chromeProbeTestMs(1),
  );

  test(
    'a path that cannot be spawned is false, never a throw',
    async () => {
      expect(await startsChrome(join(scratch, 'absent'), 'linux')).toBe(false);
    },
    chromeProbeTestMs(1),
  );
});

// A test awaiting a probe is given every probe it may run at its full deadline, never Bun's 5 s: a
// cold Chrome answering `--version` on a loaded runner outlived that default (run 43802046886).
describe('the deadline of a test that awaits a probe', () => {
  test('each probe adds its whole deadline to the work a test had before it awaited one', () => {
    const base = chromeProbeTestMs(0);
    expect(base).toBeGreaterThanOrEqual(5_000);
    expect(chromeProbeTestMs(1)).toBe(base + CHROME_PROBE_TIMEOUT_MS);
    expect(chromeProbeTestMs(3, SHORT_MS)).toBe(base + 3 * SHORT_MS);
  });

  test('findChrome gets one probe per candidate of the platform it searches', () => {
    const linux = chromeCandidates('linux', {}).length;
    expect(linux).toBeGreaterThan(1);
    expect(findChromeTestMs('linux', {})).toBe(chromeProbeTestMs(linux));
    // The per-user macOS bundle is a candidate only with a HOME, and so is its probe.
    expect(findChromeTestMs('darwin', { HOME: '/Users/ada' })).toBe(
      findChromeTestMs('darwin', {}) + CHROME_PROBE_TIMEOUT_MS,
    );
  });

  test('on Windows no candidate is run, so none is budgeted', () => {
    expect(findChromeTestMs('win32', {})).toBe(chromeProbeTestMs(0));
  });
});
