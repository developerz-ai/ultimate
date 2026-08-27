// The colour-preference axis, end to end across every driver — the vocabulary, the CDP forward,
// the refusal a launcher without the method earns, and the offline drivers' picture. Its own file
// because it is one question asked of three implementations, and because `cdp-target.test.ts` is
// at 460 of its 500 lines.

import { describe, expect, test } from 'bun:test';
import { fakeCdpBrowser } from './cdp-fake';
import { cdpTarget } from './cdp-target';
import { testClock } from './clock';
import {
  COLOR_SCHEME_FEATURE,
  COLOR_SCHEMES,
  colorSchemeFeatures,
  isColorScheme,
} from './color-scheme';
import { htmlTarget } from './html-target';
import type { PageRecording } from './recording';

const RULES = { allowHosts: ['shop.test'] };
const URL = 'https://shop.test/o';

describe('unit · the vocabulary', () => {
  // CSS's own three, and `no-preference` is the one that earns its place: without it a preference
  // once set is permanent for the session, with no way back to the launcher's default.
  test('the set is CSS prefers-color-scheme, closed at three', () => {
    expect([...COLOR_SCHEMES]).toEqual(['light', 'dark', 'no-preference']);
    expect(COLOR_SCHEME_FEATURE).toBe('prefers-color-scheme');
  });

  test('isColorScheme rejects the near misses a caller actually types', () => {
    expect(isColorScheme('dark')).toBe(true);
    // `system` is the value a component's own theme prop uses and is NOT a media-query value —
    // sending it to the browser would set a feature nobody can match.
    expect(isColorScheme('system')).toBe(false);
    expect(isColorScheme('Dark')).toBe(false);
    expect(isColorScheme(undefined)).toBe(false);
  });
});

describe('unit · the CDP driver', () => {
  test('the scheme reaches the browser as the media feature, by name', async () => {
    const browser = fakeCdpBrowser({ url: URL, html: '<p>hi</p>' });
    const page = await browser.newPage();
    const target = await cdpTarget({ page, browser, rules: RULES, clock: testClock() });

    await target.setColorScheme('dark');
    expect(browser.colorScheme).toBe('dark');
  });

  /**
   * `'no-preference'` is a CLEAR and not a value, and this is where the difference is enforced.
   * CDP treats an explicit `prefers-color-scheme: no-preference` as an OVERRIDE and an empty
   * feature list as a reset — measured on Chrome 150 headless, the two are indistinguishable on a
   * machine with no preference (both answer `dark: false, light: true`) and diverge on one that
   * has a real preference, where the override forces the light answer and the reset gives the
   * machine's own back. The reset is what this value promises.
   */
  test("'no-preference' sends the EMPTY feature list, which is CDP's own reset", async () => {
    expect(colorSchemeFeatures('dark')).toEqual([{ name: COLOR_SCHEME_FEATURE, value: 'dark' }]);
    expect(colorSchemeFeatures('no-preference')).toEqual([]);

    const browser = fakeCdpBrowser({ url: URL, html: '<p>hi</p>' });
    const page = await browser.newPage();
    const target = await cdpTarget({ page, browser, rules: RULES, clock: testClock() });

    await target.setColorScheme('dark');
    await target.setColorScheme('no-preference');
    // `null`, and never the string: the override is GONE, which is a different state from one set
    // to a value that happens to look like the default.
    expect(browser.colorScheme).toBeNull();
  });

  // The half that keeps OPTIONAL from meaning UNWIRED, exactly as `setOfflineMode` is refused: a
  // launcher predating the method must fail by name, because a silently resolved promise is how
  // this whole issue shipped — four pictures reported, two delivered.
  test('a launcher with no emulateMediaFeatures is X_NOT_IMPLEMENTED, named and fixable', async () => {
    const browser = fakeCdpBrowser({ url: URL, html: '<p>hi</p>' });
    const rich = await browser.newPage();
    const { emulateMediaFeatures: _dropped, ...page } = rich as typeof rich & {
      emulateMediaFeatures?: unknown;
    };
    const target = await cdpTarget({ page, browser, rules: RULES, clock: testClock() });

    let thrown: { code?: string; fix?: string } = {};
    try {
      await target.setColorScheme('dark');
    } catch (caught) {
      thrown = caught as { code?: string; fix?: string };
    }
    expect(thrown.code).toBe('X_NOT_IMPLEMENTED');
    expect(thrown.fix).toContain('emulateMediaFeatures');
  });

  // The port's shape is a LIST, and a caller setting another feature beside the scheme must not
  // have the scheme overwritten by position.
  test('the feature is found by name, never by position', async () => {
    const browser = fakeCdpBrowser({ url: URL, html: '<p>hi</p>' });
    const page = await browser.newPage();
    await page.emulateMediaFeatures?.([
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: COLOR_SCHEME_FEATURE, value: 'light' },
    ]);
    expect(browser.colorScheme).toBe('light');
  });
});

describe('unit · the offline drivers', () => {
  const RECORDING: PageRecording = { url: URL, html: '<p>hi</p>' };
  const offline = () =>
    htmlTarget({
      driver: 'fake',
      source: 'test',
      lookup: (url) => Promise.resolve(url === URL ? RECORDING : undefined),
      rules: RULES,
      clock: testClock(),
      start: RECORDING,
    });

  /**
   * ACCEPTED where `setOfflineMode` is REFUSED, and the picture is what makes that honest: a fake
   * answering one constant for both themes is exactly what let `x shot --island` report four
   * pictures and write two (issue #338). CI has no Chrome, so this is the only place the axis can
   * be proved at all — the same argument `clip` already made.
   */
  test('the picture differs per scheme, so a driver that dropped the preference fails', async () => {
    const target = offline();

    const before = await target.screenshot({});
    await target.setColorScheme('light');
    const light = await target.screenshot({});
    await target.setColorScheme('dark');
    const dark = await target.screenshot({});

    expect(light).not.toEqual(dark);
    // Unframed bytes are unchanged, byte for byte: every digest asserted before this existed still
    // holds, and "nothing set one" is the launcher's default rather than a value this fake invents.
    expect(before).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(new TextDecoder().decode(dark)).toContain('scheme dark');

    // The clear is a clear here too, or the offline driver would say `'no-preference'` is a third
    // picture where the real one says it is the absence of an override.
    await target.setColorScheme('no-preference');
    expect(await target.screenshot({})).toEqual(before);
  });
});
