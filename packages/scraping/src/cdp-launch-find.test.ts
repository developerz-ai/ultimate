// Which browser a run gets: the candidate order per platform, and what `findChrome` asks of a
// candidate before answering it. Nothing here launches a browser; the launch is `cdp-launch.test.ts`.

import { describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake candidate; Bun has no mkdtemp, chmod or recursive rm of its own.
import { chmod, mkdtemp, rm } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the scratch paths.
import { join } from 'node:path';
import { CHROME_CANDIDATES, CHROME_PATH_ENV, chromeCandidates, findChrome } from './cdp-launch';

/** The fakes are `#!` scripts, which Windows does not execute. */
const WINDOWS = process.platform === 'win32';

const NOWHERE = '/nonexistent/definitely-not-a-browser';

/**
 * A file that a launcher can START and that banners as a browser — what `findChrome` now asks of a
 * candidate, beside mere existence. A `#!` script, so it is skipped on Windows like every other fake
 * here (`cdp-launch-wire.ts`). An EMPTY file no longer stands in for a browser: that is the defect
 * the tests below pin.
 */
const startableFake = async (path: string): Promise<string> => {
  // `Bun.write` makes the parents (`…/Google Chrome.app/Contents/MacOS`); `writeFile` does not.
  await Bun.write(path, '#!/bin/sh\necho "Google Chrome 120.0.6099.109"\n');
  await chmod(path, 0o755);
  return path;
};

describe('findChrome', () => {
  test('CHROME_PATH wins outright, and nothing else is tried', async () => {
    // `bun` is a file that exists and is not a browser — this asks WHICH path is answered, which
    // is the whole question, and never runs it.
    const bun = process.execPath;

    expect(await findChrome({ [CHROME_PATH_ENV]: bun })).toBe(bun);
  });

  test('an empty CHROME_PATH falls back to the candidate list rather than answering it', async () => {
    // The empty string is what an unset variable becomes in a shell that exported it anyway, and
    // `Bun.file('').exists()` is false — so a rule spelled `!== undefined` would answer undefined
    // on a machine that really does have a browser.
    const found = await findChrome({ [CHROME_PATH_ENV]: '' });

    if (found !== undefined) expect(CHROME_CANDIDATES).toContain(found);
  });

  test('a CHROME_PATH pointing at nothing answers undefined, and does not silently search on', async () => {
    expect(await findChrome({ [CHROME_PATH_ENV]: NOWHERE })).toBeUndefined();
  });

  test('the candidate list is ordered, and google-chrome comes before chromium', () => {
    const order = [...chromeCandidates('linux', {})];

    expect(order[0]).toBe('/usr/bin/google-chrome');
    // A guard on the needle's presence, because `indexOf` answers -1 for an absent name and -1 is
    // less than every real index — the assertion below would hold on a list that lost the entry.
    expect(order).toContain('/usr/bin/chromium');
    expect(order.indexOf('/usr/bin/google-chrome')).toBeLessThan(
      order.indexOf('/usr/bin/chromium'),
    );
  });
});

describe('chromeCandidates', () => {
  // A browser installed where the list never looks is an e2e suite SKIPPED in silence, and an
  // `x shot` refused — which was every Windows and every macOS machine without CHROME_PATH.
  const WINDOWS_ENV = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
  };

  test('on Windows: Chrome under each install root, then Edge — the browser every Windows has', () => {
    expect(chromeCandidates('win32', WINDOWS_ENV)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
  });

  test('on Windows a root the environment does not name falls back, or is not guessed at', () => {
    const found = chromeCandidates('win32', {});
    expect(found[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    // No LOCALAPPDATA: a per-user install has no default root worth inventing.
    expect(found.some((path) => path.includes('AppData'))).toBe(false);
  });

  test('on macOS: the app bundles, system-wide then per-user', () => {
    expect(chromeCandidates('darwin', { HOME: '/Users/ada' })).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]);
  });

  test('CHROME_CANDIDATES is this machine’s list', () => {
    expect(CHROME_CANDIDATES).toEqual(chromeCandidates(process.platform, process.env));
  });

  test.skipIf(WINDOWS)('findChrome searches the list of the platform it is told', async () => {
    // A per-user macOS install, made real under a scratch HOME: found only by the darwin list.
    const home = await mkdtemp(join(tmpdir(), 'x-find-chrome-'));
    try {
      const chrome = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
      await startableFake(chrome);
      expect(await findChrome({ HOME: home }, 'darwin')).toBe(chrome);
      expect(await findChrome({ HOME: home }, 'linux')).not.toBe(chrome);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // A file that EXISTS is not a browser that STARTS, and reading the first as the second is a red
  // gate rather than a skip. Ubuntu 24.04 ships `/usr/bin/chromium-browser` as a wrapper around
  // `snap`: present and executable everywhere, and here it exits 1 having started nothing, so every
  // browser-backed suite in the run reported `X_CDP_LAUNCH_FAILED` where its own header promises a
  // SKIP. The candidate below is that wrapper, and the one after it is a browser.
  test('a candidate that exists but cannot start is passed over, never launched', async () => {
    const home = await mkdtemp(join(tmpdir(), 'x-find-chrome-dead-'));
    try {
      const dead = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
      await Bun.write(dead, '#!/bin/sh\nexit 1\n');
      await chmod(dead, 0o755);
      // No CHROME_PATH: the list is searched, finds the dead wrapper, and answers NOTHING — which
      // the caller reads as "no browser", the skip. A launcher that answered it failed on both
      // starts instead.
      expect(await findChrome({ HOME: home }, 'darwin')).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.skipIf(WINDOWS)('a --version that names no browser is not a browser', async () => {
    // `bun --version` exits 0 and prints `1.4.4`: "exited 0 and printed a number" accepts a runtime
    // that cannot render a page. The banner must name the product.
    const home = await mkdtemp(join(tmpdir(), 'x-find-chrome-not-'));
    try {
      const notBrowser = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
      await Bun.write(notBrowser, '#!/bin/sh\necho "1.4.4"\n');
      await chmod(notBrowser, 0o755);
      expect(await findChrome({ HOME: home }, 'darwin')).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.skipIf(WINDOWS)('a candidate that starts and stops cleanly in silence', async () => {
    // Windows' `chrome.exe` prints no console banner even when it starts perfectly. Reading silence
    // as "not a browser" answers undefined and silently skips every browser-backed test on that
    // runner; the probe must judge only what it was told.
    const home = await mkdtemp(join(tmpdir(), 'x-find-chrome-quiet-'));
    try {
      const quiet = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
      await Bun.write(quiet, '#!/bin/sh\nexit 0\n');
      await chmod(quiet, 0o755);
      expect(await findChrome({ HOME: home }, 'darwin')).toBe(quiet);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.skipIf(WINDOWS)('a bannering browser is answered; CHROME_PATH is not probed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'x-find-chrome-live-'));
    try {
      const chrome = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
      await startableFake(chrome);
      expect(await findChrome({ HOME: home }, 'darwin')).toBe(chrome);
      // The operator's answer, taken as given: a wrapper or a non-standard build cannot be described
      // by any list, and probing it would overrule the one caller who knows better.
      const bun = process.execPath;
      expect(await findChrome({ [CHROME_PATH_ENV]: bun })).toBe(bun);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
