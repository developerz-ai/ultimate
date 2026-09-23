// Which browser `x shot` gets, decided over plain inputs before a dev server exists to pay for a
// typo — and the driver it hands back, which is the raw-CDP one whatever the run named. No browser
// library is resolved from the app any more, so there is no install to be told about.

import { describe, expect, test } from 'bun:test';
import {
  appBrowser,
  BROWSER_CDP_URL_VAR,
  browserBinaryExists,
  cdpUrlFrom,
  cdpUrlProblem,
  executablePathFrom,
} from './browser-launcher';
import { CDP_SHOT_DRIVER } from './cdp-shot-driver';

describe('unit · the driver a run photographs with', () => {
  test('nothing to launch and nothing to attach to is refused before any boot', async () => {
    const error = await appBrowser({}).catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_BROWSER_MISSING');
    expect((error as { fix: string }).fix).toStartWith('export CHROME_PATH=');
  });

  test('a binary or an endpoint is the raw-CDP driver, and nothing launches until open()', async () => {
    expect((await appBrowser({ executablePath: '/no/such/chrome' })).name).toBe(CDP_SHOT_DRIVER);
    expect((await appBrowser({ cdpUrl: 'wss://cdp.example.com/session/abc' })).name).toBe(
      CDP_SHOT_DRIVER,
    );
  });
});

describe('unit · which binary a run launches', () => {
  /** Injected, so the probe's four paths are asserted the same on a box with Chrome and without. */
  const nothingInstalled = (): boolean => false;

  test('the flag wins, then PUPPETEER_EXECUTABLE_PATH, then CHROME_PATH', () => {
    const env = { PUPPETEER_EXECUTABLE_PATH: '/env/chrome', CHROME_PATH: '/fallback/chrome' };
    expect(executablePathFrom('/flag/chrome', env, nothingInstalled)).toBe('/flag/chrome');
    expect(executablePathFrom(undefined, env, nothingInstalled)).toBe('/env/chrome');
    expect(
      executablePathFrom(undefined, { CHROME_PATH: '/fallback/chrome' }, nothingInstalled),
    ).toBe('/fallback/chrome');
  });

  /** The last resort: the four paths `cdp-launch.ts` probes for the e2e driver, never a second list. */
  test('nothing named falls back to the probe the e2e driver already uses', () => {
    expect(executablePathFrom(undefined, {}, (path) => path === '/usr/bin/google-chrome')).toBe(
      '/usr/bin/google-chrome',
    );
    // First hit wins, in the list's own order — the operator's `CHROME_PATH` is above all four.
    expect(executablePathFrom(undefined, {}, (path) => path.startsWith('/usr/bin/chromium'))).toBe(
      '/usr/bin/chromium',
    );
    expect(executablePathFrom(undefined, { CHROME_PATH: '/named' }, () => true)).toBe('/named');
  });

  // Undefined, never `''`: an empty path is a launch of nothing. `shotBrowserChoice` turns this into
  // the refusal.
  test('nothing named and nothing installed is undefined', () => {
    expect(executablePathFrom(undefined, {}, nothingInstalled)).toBeUndefined();
    expect(
      executablePathFrom('', { PUPPETEER_EXECUTABLE_PATH: '' }, nothingInstalled),
    ).toBeUndefined();
  });

  test('a named binary is checked against the filesystem', () => {
    expect(browserBinaryExists(import.meta.path)).toBe(true);
    expect(browserBinaryExists('/no/such/chrome')).toBe(false);
  });
});

/**
 * Attaching is what every stealth provider sells: a session created over their API answers with a
 * `wss://` CDP endpoint, and the browser behind it is one this box could not have launched.
 */
describe('unit · a browser somebody else is running', () => {
  test('the flag wins over the environment, and an empty value is not a value', () => {
    const env = { [BROWSER_CDP_URL_VAR]: 'wss://from-env/session' };
    expect(cdpUrlFrom('wss://from-flag/session', env)).toBe('wss://from-flag/session');
    expect(cdpUrlFrom(undefined, env)).toBe('wss://from-env/session');
    expect(cdpUrlFrom('', env)).toBe('wss://from-env/session');
    expect(cdpUrlFrom(undefined, { [BROWSER_CDP_URL_VAR]: '' })).toBeUndefined();
    expect(cdpUrlFrom(undefined, {})).toBeUndefined();
  });

  test('the scheme is judged here, so a typo costs no provider session', () => {
    expect(cdpUrlProblem('wss://cdp.browser-use.com/abc')).toBeUndefined();
    expect(cdpUrlProblem('ws://127.0.0.1:9222/devtools/browser/x')).toBeUndefined();
    // A sidecar's `/json/version` endpoint is HTTP, and the driver resolves it to the socket.
    expect(cdpUrlProblem('http://chrome:9222')).toBeUndefined();
    expect(String(cdpUrlProblem('cdp.example.com'))).toContain('is not a URL');
    expect(String(cdpUrlProblem('file:///tmp/x'))).toContain('has scheme "file:"');
  });
});
