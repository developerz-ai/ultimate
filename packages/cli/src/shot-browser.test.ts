// The three rules that decide which browser a capture runs in. Each is one silent failure away
// from a picture of the wrong thing — or from a correct remote run refused on a box with no Chrome
// — so each is asserted here, against plain inputs, with no dev server and no browser anywhere.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { BROWSER_CDP_URL_VAR } from './browser-launcher';
import { shotBrowserChoice } from './shot-browser';

const thrownBy = (run: () => unknown): Record<string, unknown> => {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  return {};
};

const CDP = 'wss://cdp.example.com/session/abc';

/**
 * Injected, never the real filesystem: the probe these rules end in reads `/usr/bin/google-chrome`
 * and three siblings, so a test that let it through would answer differently on a CI runner (which
 * ships Chrome) than in a bare container (which does not) — a verdict that is the box, not the code.
 */
const NO_BROWSER_ANYWHERE = (): boolean => false;
const INSTALLED = (path: string): boolean => path === '/usr/bin/chromium';

describe('unit · start a browser here, or attach to one somebody else is running', () => {
  test('a --cdp-url is what the run attaches to, and no executable is read', () => {
    expect(shotBrowserChoice({ cdpFlag: CDP, env: {} })).toEqual({ cdpUrl: CDP });

    // The env names a binary and the run still attaches: reading it would refuse a correct remote
    // capture on a machine whose PUPPETEER_EXECUTABLE_PATH points at nothing.
    expect(
      shotBrowserChoice({ cdpFlag: CDP, env: { PUPPETEER_EXECUTABLE_PATH: '/no/such/chrome' } }),
    ).toEqual({ cdpUrl: CDP });
  });

  test('SCRAPE_CDP_URL attaches a run that named no browser at all', () => {
    expect(shotBrowserChoice({ env: { [BROWSER_CDP_URL_VAR]: CDP } })).toEqual({ cdpUrl: CDP });
  });

  /**
   * The defect this rule exists for: `x shot /` with Chrome at `/usr/bin/google-chrome` used to
   * answer `undefined` and hand `puppeteer-core` no `executablePath` at all — which is a throw from
   * inside the library, AFTER the embedded Postgres, saying to specify one. The framework already
   * knew where Chrome lives; only the e2e driver was asking.
   */
  test('an installed Chrome nobody named is found, so a bare x shot / has a browser', () => {
    expect(shotBrowserChoice({ env: {}, exists: INSTALLED })).toEqual({
      executablePath: '/usr/bin/chromium',
    });
  });

  /**
   * And when the probe finds nothing, the refusal is HERE — before `devServerFor`, before an
   * embedded Postgres, and naming a repair (`bun add -d puppeteer-core` cannot install a browser).
   */
  test('no browser named and none on disk is refused before anything boots', () => {
    const error = thrownBy(() => shotBrowserChoice({ env: {}, exists: NO_BROWSER_ANYWHERE }));
    expect(error['code']).toBe('X_SHOT_BROWSER_MISSING');
    expect(String(error['fix'])).toContain('export CHROME_PATH=/usr/bin/google-chrome');
    // The cause has to say what was looked at, or the reader cannot tell "no Chrome" from
    // "a Chrome this run could not see".
    expect(String(error['cause'])).toContain('/usr/bin/google-chrome-stable');
    expect(String(error['cause'])).toContain('CHROME_PATH');
  });

  /**
   * A named path is answered as named even when it is absent, and never replaced by a probed one:
   * an operator who exported `CHROME_PATH` has a belief about which binary runs, and a silent
   * substitution photographs the page in a browser they did not choose.
   */
  test('an absent CHROME_PATH is reported, not quietly replaced by an installed Chrome', () => {
    const error = thrownBy(() =>
      shotBrowserChoice({ env: { CHROME_PATH: '/no/such/chrome' }, exists: INSTALLED }),
    );
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot / --browser /usr/bin/chromium',
    ]);
    expect(String(error['cause'])).toContain('/no/such/chrome');
  });

  /**
   * One names a Chrome to START and the other says the browser is somebody else's. A reader who
   * typed both has a belief about which one runs and half of them would be wrong, so neither is
   * preferred — the same rule `--island` with a route positional follows.
   */
  test('both flags together is refused rather than ranked', () => {
    const error = thrownBy(() =>
      shotBrowserChoice({ cdpFlag: CDP, browserFlag: '/usr/bin/chromium', env: {} }),
    );
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
    expect(String((error as unknown as UltimateError).message)).toContain('--cdp-url');
  });

  /**
   * An exported variable is a shell-wide default, not a typed intent. Ranking it above the flag
   * would make one `export` silently redirect every local capture in the session — a flag that
   * parses, reports nothing and attaches somewhere else, which `flag-reads.ts` cannot see because
   * the flag IS read.
   */
  test('an explicit --browser beats an exported SCRAPE_CDP_URL, and is not a conflict', () => {
    const error = thrownBy(() =>
      shotBrowserChoice({
        browserFlag: '/no/such/chrome',
        env: { [BROWSER_CDP_URL_VAR]: CDP },
      }),
    );
    // Reached the executable check — which is the browser it was told to use, not the attach.
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot / --browser /usr/bin/chromium',
    ]);
  });

  test('a --cdp-url that is not a CDP endpoint is refused before the attach', () => {
    const error = thrownBy(() => shotBrowserChoice({ cdpFlag: 'cdp.example.com', env: {} }));
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot / --cdp-url wss://cdp.example.com/session/abc',
    ]);
  });

  test('a browser named on disk is answered as the path to launch', () => {
    // This file exists in every checkout this test runs in, which is the point: the rule is "the
    // named binary is really there", and a real path is the only honest way to assert it passes.
    const real = import.meta.path;
    expect(shotBrowserChoice({ browserFlag: real, env: {} })).toEqual({ executablePath: real });
  });
});
