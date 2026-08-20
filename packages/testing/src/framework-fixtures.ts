// Registers the fixtures the FRAMEWORK owns, so an app registers only what it owns (`seed`,
// `actorFor`, …). Called by the preload, which is why an app never writes
// `defineFixtures({ clock })` and why two apps cannot disagree about what `clock` means.

import { createTestClock } from './fixture-clock';
import { DRIVER_FIXTURE_NAMES, driverFixtures } from './fixture-drivers';
import { createRunJobs } from './fixture-jobs';
import { createTestMail } from './fixture-mail';
import { createTestNetwork } from './fixture-network';
import { createTestStatements } from './fixture-statements';
import { createSubscribeDriver } from './fixture-subscribe';
import { defineFixtures } from './fixtures';

/**
 * Built in-process. Always available, in every test type — the first of the bag's two kinds of
 * member. The other is `DRIVER_FIXTURE_NAMES`: declared here, built by a driver the process
 * installs. See `fixture-drivers.ts` for why a declared-and-unavailable fixture beats an
 * unregistered name.
 */
export const FRAMEWORK_FIXTURE_NAMES = [
  'clock',
  'mail',
  'network',
  'runJobs',
  'statements',
  // Moved here from `DRIVER_FIXTURE_NAMES` on 2026-08-20: the driver it was waiting for is
  // `createSubscribeDriver()`, and the framework can build one — a whole `sync` node in this
  // process, over the change source `@ultimat3/entity`'s `setRowObserver` gives it. The four left
  // in that list all need something the framework genuinely cannot bundle: a browser, or a
  // second build.
  'subscribe',
] as const;

export { DRIVER_FIXTURE_NAMES };

/** Every name the framework puts in the bag, in the order `registeredFixtures()` reports them. */
export const ALL_FIXTURE_NAMES: readonly string[] = [
  ...FRAMEWORK_FIXTURE_NAMES,
  ...DRIVER_FIXTURE_NAMES,
].sort();

/**
 * Each factory imports its subsystem on demand, for the reason the whole registry is lazy: a test
 * that never touches jobs must not pay for the queue, and a `packages/core` test must not boot
 * mail. `defineFixtures` merges, so registering twice is idempotent — and so a driver registered
 * afterwards replaces the declaration it was waiting on.
 */
export function registerFrameworkFixtures(): void {
  defineFixtures({
    ...driverFixtures(),
    clock: createTestClock,
    mail: createTestMail,
    network: createTestNetwork,
    runJobs: createRunJobs,
    statements: createTestStatements,
    // After the spread, so it REPLACES the `unavailableFixture('subscribe')` declaration above it —
    // `defineFixtures` merges and the last registration wins, which is the same seam an app's own
    // driver uses.
    subscribe: async () => (await createSubscribeDriver()).subscribe,
  });
}
