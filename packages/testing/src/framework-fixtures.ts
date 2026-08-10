// Registers the fixtures the FRAMEWORK owns, so an app registers only what it owns (`seed`,
// `actorFor`, …). Called by the preload, which is why an app never writes `defineFixtures({ clock })`
// and why two apps cannot disagree about what `clock` means.
//
// Two lists, because the bag has two kinds of member. The first four are built here and always
// work. The rest are declared here and built by a driver the process installs — see
// `fixture-drivers.ts` for why a declared-and-unavailable fixture beats an unregistered name.
//
// Each factory imports its subsystem on demand, for the reason the whole registry is lazy: a test
// that never touches jobs must not pay for the queue, and a `packages/core` test must not boot
// mail. `defineFixtures` merges, so registering twice is idempotent — and so a driver registered
// afterwards replaces the declaration it was waiting on.

import { createTestClock } from './fixture-clock';
import { DRIVER_FIXTURE_NAMES, driverFixtures } from './fixture-drivers';
import { createRunJobs } from './fixture-jobs';
import { createTestMail } from './fixture-mail';
import { createTestNetwork } from './fixture-network';
import { defineFixtures } from './fixtures';

/** Built in-process. Always available, in every test type. */
export const FRAMEWORK_FIXTURE_NAMES = ['clock', 'mail', 'network', 'runJobs'] as const;

export { DRIVER_FIXTURE_NAMES };

/** Every name the framework puts in the bag, in the order `registeredFixtures()` reports them. */
export const ALL_FIXTURE_NAMES: readonly string[] = [
  ...FRAMEWORK_FIXTURE_NAMES,
  ...DRIVER_FIXTURE_NAMES,
].sort();

export function registerFrameworkFixtures(): void {
  defineFixtures({
    ...driverFixtures(),
    clock: createTestClock,
    mail: createTestMail,
    network: createTestNetwork,
    runJobs: createRunJobs,
  });
}
