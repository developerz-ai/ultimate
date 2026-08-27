// The registration seam: absent by default, whole when installed, and undone by every case here —
// the fixture registry is process-global and `bun test` is one process, so a driver left behind
// would hand every later file a `page` fixture nobody asked for.

import { afterEach, describe, expect, test } from 'bun:test';
import type { FixtureMap } from '@ultimat3/testing';
import {
  clearFixtures,
  defineFixtures,
  fixtureSnapshot,
  hasE2eDriver,
  registeredFixtures,
  registerFrameworkFixtures,
} from '@ultimat3/testing';
import { e2eFixtures, installE2eDriver } from './e2e-driver';
import type { E2eBrowserPage } from './e2e-page';
import { e2ePage } from './e2e-page';

const browser: E2eBrowserPage = {
  url: () => 'http://127.0.0.1:3000/feed',
  goto: () => Promise.resolve(undefined),
  evaluate: () => Promise.resolve(JSON.stringify({ count: 1, visible: true, marked: false })),
  click: () => Promise.resolve(),
};

const options = { page: browser, baseUrl: 'http://127.0.0.1:3000' };

/** What the registry would build for one name — the half `fixtureTest` reaches through a body. */
const build = async (name: string): Promise<unknown> => {
  const factory = fixtureSnapshot()[name];
  if (factory === undefined) return 'no such fixture';
  return await factory();
};

const refusalFor = async (name: string): Promise<string> => {
  try {
    await build(name);
  } catch (error) {
    return String(error);
  }
  return 'nothing was thrown';
};

/** Every case restores what it found, registry and driver seam alike. */
const around = (body: () => void | Promise<void>) => async (): Promise<void> => {
  const snapshot: FixtureMap = fixtureSnapshot();
  try {
    clearFixtures();
    registerFrameworkFixtures();
    await body();
  } finally {
    clearFixtures();
    defineFixtures(snapshot);
  }
};

afterEach(() => {
  expect(hasE2eDriver()).toBe(false);
});

describe('e2e driver — absent by default', () => {
  test(
    'the declared page fixture refuses until something installs a driver',
    around(async () => {
      expect(await refusalFor('page')).toContain('X_TEST_FIXTURE_UNAVAILABLE');
    }),
  );

  test(
    'and hasE2eDriver() answers false, which is what a harness reads instead of an all-skipped run',
    around(() => {
      expect(hasE2eDriver()).toBe(false);
    }),
  );
});

describe('e2e driver — installed', () => {
  test(
    'installing registers the e2eTest driver, and the undo removes it',
    around(() => {
      const undo = installE2eDriver(options);
      expect(hasE2eDriver()).toBe(true);
      undo();
      expect(hasE2eDriver()).toBe(false);
    }),
  );

  test(
    'the page fixture builds a real PageLike',
    around(async () => {
      const undo = installE2eDriver(options);
      const page = (await build('page')) as { url(): string };
      undo();
      expect(page.url()).toBe('http://127.0.0.1:3000/feed');
    }),
  );

  test(
    'the undo restores the DECLARATION rather than deleting the key',
    around(async () => {
      installE2eDriver(options)();
      expect(registeredFixtures()).toContain('page');
      // X_TEST_FIXTURE_UNAVAILABLE and never X_TEST_FIXTURE_UNKNOWN: "register it" is the wrong
      // instruction for a name the framework itself declares.
      expect(await refusalFor('page')).toContain('X_TEST_FIXTURE_UNAVAILABLE');
    }),
  );

  test(
    'budget is left refusing — byte counts come off a built dist/, not off a page',
    around(async () => {
      const undo = installE2eDriver(options);
      const refusal = await refusalFor('budget');
      undo();
      expect(refusal).toContain('X_TEST_FIXTURE_UNAVAILABLE');
    }),
  );

  test(
    'signIn is left refusing — the sign-in route is the app’s, not the framework’s',
    around(async () => {
      const undo = installE2eDriver(options);
      const refusal = await refusalFor('signIn');
      undo();
      expect(refusal).toContain('X_TEST_FIXTURE_UNAVAILABLE');
    }),
  );

  test(
    'deploy is left refusing — a new build id is a server fact',
    around(async () => {
      const undo = installE2eDriver(options);
      const refusal = await refusalFor('deploy');
      undo();
      expect(refusal).toContain('X_TEST_FIXTURE_UNAVAILABLE');
    }),
  );
});

describe('e2e driver — the fixtures an e2eTest body receives', () => {
  const page = e2ePage(options);

  test('page is the real one', () => {
    expect(e2eFixtures(page, browser).page.url()).toBe('http://127.0.0.1:3000/feed');
  });

  /**
   * The condition, not the call. `offline()` refused until 2026-08-27 on a reason the tree
   * contradicted in the commit that wrote it — `CdpPageLike` has declared `setOfflineMode` since
   * #351 and `ScrapePage.offline()` forwards to it — and #390 recorded a real browser check as out
   * of reach because of it. Asserting the value the driver was left in, rather than that a spy
   * fired, is what makes this fail if the forward is inverted.
   */
  const withNetwork = (): { readonly browser: E2eBrowserPage; readonly state: boolean[] } => {
    const state: boolean[] = [];
    return {
      browser: {
        ...browser,
        offline: (enabled: boolean) => {
          state.push(enabled);
          return Promise.resolve();
        },
      },
      state,
    };
  };

  test('offline() drops the browser network, and online() puts it back', async () => {
    const { browser: driver, state } = withNetwork();
    const fixtures = e2eFixtures(page, driver);
    await fixtures.offline();
    expect(state).toEqual([true]);
    await fixtures.online();
    expect(state).toEqual([true, false]);
  });

  test('a driver with no offline() still REFUSES rather than no-opping', async () => {
    // The whole reason this half is a refusal: an `offline()` that silently did nothing would let
    // the app's ONLINE page pass an offline test, and the assertion after it would read as proof.
    await expect(e2eFixtures(page, browser).offline()).rejects.toThrow(
      /X_TEST_FIXTURE_UNAVAILABLE/,
    );
    await expect(e2eFixtures(page, browser).online()).rejects.toThrow(/X_TEST_FIXTURE_UNAVAILABLE/);
  });

  test('and that refusal names the method the double is missing, not a missing capability', async () => {
    let message = '';
    try {
      await e2eFixtures(page, browser).offline();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('offline(enabled)');
    // It must NOT send the reader after a CDP method the framework already has — that sentence is
    // what kept #390 blocked.
    expect(message).not.toContain('setOfflineMode');
  });

  test('update() refuses, and names the second build it would need', async () => {
    let message = '';
    try {
      await e2eFixtures(page, browser).update();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('build id');
  });
});
