// The names the framework declares but cannot build: that asking for one without a driver fails as
// UNAVAILABLE rather than UNKNOWN, that it fails when built rather than when used, and that a
// driver arrives through the ordinary registry merge — whole, or not at all.

import { afterAll, test as bunTest, describe, expect } from 'bun:test';
import {
  DRIVER_FIXTURE_NAMES,
  DRIVER_FIXTURE_NEEDS,
  driverFixtures,
  unavailableFixture,
} from './fixture-drivers';
import { defineFixtures, fixtureSnapshot, registeredFixtures, runWithFixtures } from './fixtures';
import { registerFrameworkFixtures } from './framework-fixtures';
import type { LocatorLike, PageLike } from './test-types';
import { testName } from './test-types';

// The registry is process-global. This file registers a driver over `page`, so it hands the
// framework's own declaration back — otherwise every later file inherits this file's stub.
const BEFORE = fixtureSnapshot();
afterAll(() => {
  defineFixtures(BEFORE);
});

const stubLocator = (): LocatorLike => ({
  count: async () => 0,
  click: async () => undefined,
  first: () => stubLocator(),
  isVisible: async () => false,
});

/** A driver is a whole `PageLike` or it is not a driver — see the rejection case below. */
const stubPage = (url: string): PageLike => ({
  goto: async () => undefined,
  gotoStreamed: async () => ({ html: '' }),
  reload: async () => undefined,
  waitForServiceWorker: async () => undefined,
  title: async () => '',
  url: () => url,
  evaluate: async <T>(fn: () => T) => fn(),
  locator: stubLocator,
  getByRole: stubLocator,
  getByText: stubLocator,
});

describe(testName('unit', 'the declared-but-driverless fixtures'), () => {
  bunTest('every declared name has a driver requirement written down', () => {
    // `subscribe` left this list on 2026-08-20: the driver it was waiting for is
    // `createSubscribeDriver()`, and the framework can build one. What is left all needs something
    // the framework genuinely cannot bundle — a browser, or a second build.
    expect([...DRIVER_FIXTURE_NAMES]).toEqual(['budget', 'deploy', 'page', 'signIn']);
    for (const name of DRIVER_FIXTURE_NAMES) {
      expect(DRIVER_FIXTURE_NEEDS[name].length).toBeGreaterThan(10);
    }
  });

  bunTest('the bag registers one factory per declared name', () => {
    expect(Object.keys(driverFixtures()).sort()).toEqual([...DRIVER_FIXTURE_NAMES]);
  });

  // The distinction this whole file exists for: `page` IS registered, so "register it" — the fix
  // X_TEST_FIXTURE_UNKNOWN prints — would be the wrong instruction. The failure has to say driver.
  bunTest('a declared name resolves, and fails as UNAVAILABLE rather than UNKNOWN', async () => {
    registerFrameworkFixtures();
    expect(registeredFixtures()).toContain('page');

    await expect(runWithFixtures(async ({ page }) => void page)).rejects.toBeUltimateError(
      'X_TEST_FIXTURE_UNAVAILABLE',
    );
  });

  bunTest('the failure names the fixture and what it is waiting on', () => {
    expect(() => unavailableFixture('page')()).toThrow(/page/);
    expect(() => unavailableFixture('page')()).toThrow(/browser/);
  });

  // Throwing when built, not when used: a fixture that returned a proxy would surface three
  // awaits later as a missing method, pointing at the assertion instead of the missing driver.
  bunTest('it throws at build time, before the body runs', async () => {
    let bodyRan = false;
    await expect(
      runWithFixtures(async ({ budget }) => {
        bodyRan = true;
        void budget;
      }),
    ).rejects.toBeUltimateError('X_TEST_FIXTURE_UNAVAILABLE');
    expect(bodyRan).toBe(false);
  });

  // How a browser driver arrives: the ordinary registry merge, no second seam to learn.
  bunTest('a registered driver replaces the declaration', async () => {
    registerFrameworkFixtures();
    defineFixtures({ page: () => stubPage('/feed') });

    let seen = '';
    await runWithFixtures(async ({ page }) => {
      seen = page.url();
    });

    expect(seen).toBe('/feed');
  });

  // The declared type is the contract a driver signs, so a half-built one is a compile error at
  // the registration — not a missing method three awaits into some later test. `@ts-expect-error`
  // fails the compile if this ever starts type-checking, which is the assertion.
  bunTest('a half-built driver does not type-check', () => {
    registerFrameworkFixtures();
    // @ts-expect-error `url()` alone is not a PageLike — no goto, no locator, no service worker.
    expect(() => defineFixtures({ page: () => ({ url: () => '/feed' }) })).not.toThrow();
    defineFixtures(BEFORE);
  });
});
