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
    expect(shotBrowserChoice({ env: {} })).toEqual({});
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
