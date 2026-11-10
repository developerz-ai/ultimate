// The conformance suite over the memory guard, and the proof it can fail: a guard that reads, waits,
// then writes (the two round trips two replicas fit between), and one that forgets the subject.

import { describe, expect, test } from 'bun:test';
import { memoryTotpReplayGuard } from '@ultimat3/auth';
import type { TotpReplayGuard } from '@ultimat3/auth/adapter';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';
import {
  TOTP_REPLAY_GUARD_CHECKS,
  totpReplayGuardConformance,
} from './totp-replay-guard-conformance';

describe(testName('unit', 'the memory TOTP replay guard'), () => {
  behavesLike(totpReplayGuardConformance, () => memoryTotpReplayGuard());
});

/** A check, then a turn of the event loop, then the write — every concurrent claimer passes. */
const checkThenWrite = (): TotpReplayGuard => {
  const spent = new Set<string>();
  return {
    claim: async (subject, step) => {
      const key = `${subject}:${step}`;
      const seen = spent.has(key);
      await Promise.resolve();
      if (seen) return false;
      spent.add(key);
      return true;
    },
  };
};

/** One table keyed by the step alone: Ada's code spends Grace's. */
const subjectBlind = (): TotpReplayGuard => {
  const inner = memoryTotpReplayGuard();
  return { claim: (_subject, step, at) => inner.claim('everyone', step, at) };
};

const check = (name: string) => {
  const found = TOTP_REPLAY_GUARD_CHECKS.find((each) => each.name.includes(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a guard that breaks the contract fails conformance'), () => {
  test('a claim that checks and writes in two steps', async () => {
    const race = check('concurrent claims');
    await expect(race.run(checkThenWrite())).rejects.toThrow();
    await race.run(memoryTotpReplayGuard());
  });

  test('a claim that ignores the subject', async () => {
    const isolation = check('spent per subject');
    await expect(isolation.run(subjectBlind())).rejects.toThrow();
    await isolation.run(memoryTotpReplayGuard());
  });

  test('every check has a name of its own', () => {
    const names = TOTP_REPLAY_GUARD_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
