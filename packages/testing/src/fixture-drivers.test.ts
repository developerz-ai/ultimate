import { afterAll, test as bunTest, describe, expect } from 'bun:test';
import {
  DRIVER_FIXTURE_NAMES,
  DRIVER_FIXTURE_NEEDS,
  driverFixtures,
  unavailableFixture,
} from './fixture-drivers';
import { defineFixtures, fixtureSnapshot, registeredFixtures, runWithFixtures } from './fixtures';
import { registerFrameworkFixtures } from './framework-fixtures';

// The registry is process-global. This file registers a driver over `page`, so it hands the
// framework's own declaration back — otherwise every later file inherits this file's stub.
const BEFORE = fixtureSnapshot();
afterAll(() => {
  defineFixtures(BEFORE);
});

describe('unit · the declared-but-driverless fixtures', () => {
  bunTest('every declared name has a driver requirement written down', () => {
    expect([...DRIVER_FIXTURE_NAMES]).toEqual(['budget', 'deploy', 'page', 'signIn', 'subscribe']);
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
    expect(() => unavailableFixture('subscribe')()).toThrow(/subscribe/);
    expect(() => unavailableFixture('subscribe')()).toThrow(/replicator/);
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
    defineFixtures({ page: () => ({ url: () => '/feed' }) });

    let seen = '';
    await runWithFixtures(async ({ page }) => {
      seen = page.url();
    });

    expect(seen).toBe('/feed');
  });
});
