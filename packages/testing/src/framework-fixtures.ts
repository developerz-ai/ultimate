// Registers the fixtures the FRAMEWORK owns — `clock`, `mail`, `runJobs` — so an app registers
// only what it owns (`seed`, `actorFor`, …). Called by the preload, which is why an app never
// writes `defineFixtures({ clock })` and why two apps cannot disagree about what `clock` means.
//
// Each factory imports its subsystem on demand, for the reason the whole registry is lazy: a
// test that never touches jobs must not pay for the queue, and a `packages/core` test must not
// boot mail. `defineFixtures` merges, so registering twice is idempotent.

import { createTestClock } from './fixture-clock';
import { createRunJobs } from './fixture-jobs';
import { createTestMail } from './fixture-mail';
import { defineFixtures } from './fixtures';

export const FRAMEWORK_FIXTURE_NAMES = ['clock', 'mail', 'runJobs'] as const;

export function registerFrameworkFixtures(): void {
  defineFixtures({
    clock: createTestClock,
    mail: createTestMail,
    runJobs: createRunJobs,
  });
}
