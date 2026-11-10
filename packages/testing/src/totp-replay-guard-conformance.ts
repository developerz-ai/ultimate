// The `TotpReplayGuard` contract of `@ultimat3/auth` as shared examples, for a guard of your own:
// `behavesLike(totpReplayGuardConformance, () => guard)`. One atomic claim per (subject, step): a
// code is single-use across every replica that shares the guard, and two concurrent completions
// carrying one code admit exactly one.

import { expect, test } from 'bun:test';
import type { TotpReplayGuard } from '@ultimat3/auth/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface TotpReplayGuardCheck {
  readonly name: string;
  run(guard: TotpReplayGuard): Promise<void>;
}

/** A TOTP step is 30 s. `at` and `step` agree, as `verifyTotp` hands them over. */
const STEP_MS = 30_000;
const AT = new Date('2031-03-04T05:06:00.000Z');
const STEP = Math.floor(AT.getTime() / STEP_MS);
const later = (steps: number): Date => new Date(AT.getTime() + steps * STEP_MS);
const RACERS = 10;

/** A subject no other check, run or process shares — a shared table holds every run's steps. */
const subjectOf = (label: string): string => `conformance:${label}:${crypto.randomUUID()}`;

export const TOTP_REPLAY_GUARD_CHECKS: readonly TotpReplayGuardCheck[] = [
  {
    name: 'the first claim of a step is true, every repeat is false',
    async run(guard) {
      const subject = subjectOf('once');
      expect(await guard.claim(subject, STEP, AT)).toBe(true);
      expect(await guard.claim(subject, STEP, AT)).toBe(false);
      expect(await guard.claim(subject, STEP, later(1))).toBe(false);
    },
  },
  {
    name: 'a step is spent per subject, and a neighbouring step is its own',
    async run(guard) {
      const [ada, grace] = [subjectOf('ada'), subjectOf('grace')];
      expect(await guard.claim(ada, STEP, AT)).toBe(true);
      expect(await guard.claim(grace, STEP, AT)).toBe(true);
      expect(await guard.claim(ada, STEP + 1, AT)).toBe(true);
      expect(await guard.claim(ada, STEP - 1, AT)).toBe(true);
    },
  },
  {
    name: 'a step spent stays spent while the drift window can still offer it',
    async run(guard) {
      const subject = subjectOf('window');
      expect(await guard.claim(subject, STEP, AT)).toBe(true);
      expect(await guard.claim(subject, STEP + 1, later(1))).toBe(true);
      // One step on, `verifyTotp` with the default drift still offers STEP: it must still be spent.
      expect(await guard.claim(subject, STEP, later(1))).toBe(false);
    },
  },
  {
    name: `${RACERS} concurrent claims of one step: exactly one is true`,
    async run(guard) {
      const subject = subjectOf('race');
      const answers = await Promise.all(
        Array.from({ length: RACERS }, () => guard.claim(subject, STEP, AT)),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
    },
  },
];

export const totpReplayGuardConformance: SharedExamples<
  TotpReplayGuard | Promise<TotpReplayGuard>
> = sharedExamples('a TOTP replay guard', (subject) => {
  for (const check of TOTP_REPLAY_GUARD_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
