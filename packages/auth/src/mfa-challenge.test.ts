// A spent code across replicas. The failure case first: two `defineAuth` over one adapter each
// held their own step table, so the six digits replica A had just refused signed in on replica B,
// and the documented way out (a shared guard) could not work: its answer was a `Promise`, and a
// `Promise` is truthy, so every code read as already spent and everyone was locked out.

import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import {
  memoryTotpReplayGuard,
  TOTP_DRIFT_STEPS,
  type TotpReplayGuard,
  totpCode,
  totpStep,
} from './mfa';
import { completeMfa } from './mfa-challenge';
import { saveTotpSecret } from './mfa-secret';

const EMAIL = 'ada@corp.test';
const SECRET = 'JBSWY3DPEHPK3PXP';
const START = 1_700_000_000_000;

/** One replica: its own limiter and its own `defineAuth`, over whatever the fleet shares. */
const replica = (adapter: MemoryAuthAdapter, clock: FrozenClock, guard: TotpReplayGuard): Auth =>
  defineAuth({
    adapter,
    clock,
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, orgMaxAttempts: 10_000 },
    totpReplay: guard,
  });

interface Fleet {
  readonly adapter: MemoryAuthAdapter;
  readonly clock: FrozenClock;
  readonly userId: string;
}

const fleet = async (): Promise<Fleet> => {
  const clock = frozenClock(START);
  const adapter = memoryAuthAdapter(clock);
  const auth = replica(adapter, clock, memoryTotpReplayGuard());
  const user = await register(auth, { email: EMAIL, password: PASSWORD, orgId: 'org-1' });
  await saveTotpSecret(auth, user.id, SECRET);
  return { adapter, clock, userId: user.id };
};

const challengeFrom = async (auth: Auth): Promise<string> => {
  const error = await caught(() => login(auth, { email: EMAIL, password: PASSWORD }));
  const challenge = error?.meta?.['challenge'];
  return typeof challenge === 'string' ? challenge : expect.unreachable('no challenge in meta');
};

const currentCode = (clock: FrozenClock): string => totpCode(SECRET, totpStep(clock.now()));

/** Six digits none of the steps inside the drift window answer. */
const wrongCode = (clock: FrozenClock): string => {
  const now = totpStep(clock.now());
  const live = [now - TOTP_DRIFT_STEPS, now, now + TOTP_DRIFT_STEPS].map((step) =>
    totpCode(SECRET, step),
  );
  return live.includes('000000') ? '111111' : '000000';
};

/** A guard whose every answer takes a tick, which is the shape any networked store has. */
const networked = (inner: TotpReplayGuard): TotpReplayGuard & { readonly calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    claim: async (subject, step, at) => {
      calls.push([subject, step, at]);
      await Bun.sleep(0);
      return await inner.claim(subject, step, at);
    },
  };
};

describe('a spent code stays spent across replicas', () => {
  test('two replicas sharing one guard: the third answer is a refusal', async () => {
    const { adapter, clock } = await fleet();
    const guard = memoryTotpReplayGuard();
    const podA = replica(adapter, clock, guard);
    const podB = replica(adapter, clock, guard);
    const code = currentCode(clock);

    const first = await completeMfa(podA, await challengeFrom(podA), code);
    expect(first.session.mfaSatisfied).toBe(true);

    const sameReplica = await caught(async () =>
      completeMfa(podA, await challengeFrom(podA), code),
    );
    expect(sameReplica?.code).toBe('X_UNAUTHENTICATED');

    // The probe's third answer, which was a session: pod B had never seen the step.
    const otherReplica = await caught(async () =>
      completeMfa(podB, await challengeFrom(podB), code),
    );
    expect(otherReplica?.code).toBe('X_UNAUTHENTICATED');
  });

  test('a guard that answers asynchronously admits a first use', async () => {
    const { adapter, clock } = await fleet();
    // Measured before the change: a `Promise` read as "used", so this was X_UNAUTHENTICATED for
    // every right code on every account.
    const auth = replica(adapter, clock, networked(memoryTotpReplayGuard()));
    const result = await completeMfa(auth, await challengeFrom(auth), currentCode(clock));
    expect(result.session.mfaSatisfied).toBe(true);
  });

  test('two concurrent completions over a networked guard: exactly one finishes', async () => {
    const { adapter, clock, userId } = await fleet();
    const guard = networked(memoryTotpReplayGuard());
    const podA = replica(adapter, clock, guard);
    const podB = replica(adapter, clock, guard);
    const code = currentCode(clock);
    const [challengeA, challengeB] = [await challengeFrom(podA), await challengeFrom(podB)];

    const pair = await Promise.allSettled([
      completeMfa(podA, challengeA, code),
      completeMfa(podB, challengeB, code),
    ]);

    expect(pair.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(await adapter.listSessions(userId)).toHaveLength(1);
  });
});

describe('what completeMfa asks of the guard', () => {
  test('the subject, the step the code belonged to, and the server clock', async () => {
    const { adapter, clock, userId } = await fleet();
    const guard = networked(memoryTotpReplayGuard());
    const auth = replica(adapter, clock, guard);
    await completeMfa(auth, await challengeFrom(auth), currentCode(clock));
    expect(guard.calls).toEqual([[userId, totpStep(clock.now()), clock.now()]]);
  });

  test('a wrong guess writes nothing: only a code that verified claims its step', async () => {
    const { adapter, clock } = await fleet();
    const guard = networked(memoryTotpReplayGuard());
    const auth = replica(adapter, clock, guard);
    const refused = await caught(async () =>
      completeMfa(auth, await challengeFrom(auth), wrongCode(clock)),
    );
    expect(refused?.code).toBe('X_UNAUTHENTICATED');
    expect(guard.calls).toEqual([]);
  });

  test('a lost claim stays counted, as a wrong code does', async () => {
    const { adapter, clock } = await fleet();
    const guard: TotpReplayGuard = { claim: async () => false };
    const auth = replica(adapter, clock, guard);
    const challenge = await challengeFrom(auth);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const lost = await caught(() => completeMfa(auth, challenge, currentCode(clock)));
      expect(lost?.code).toBe('X_UNAUTHENTICATED');
    }
    const locked = await caught(() => completeMfa(auth, challenge, currentCode(clock)));
    expect(locked?.code).toBe('X_ACCOUNT_LOCKED');
  });

  test('a store that fails is a fault, never a wrong code, and the guess is not counted', async () => {
    const { adapter, clock, userId } = await fleet();
    const down = new TypeError('connection refused');
    let reachable = false;
    const inner = memoryTotpReplayGuard();
    const guard: TotpReplayGuard = {
      claim: (subject, step, at) =>
        reachable ? inner.claim(subject, step, at) : Promise.reject(down),
    };
    const auth = replica(adapter, clock, guard);
    const challenge = await challengeFrom(auth);

    // One more than `maxAttempts`: a counted fault would be X_ACCOUNT_LOCKED by the sixth.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const thrown = await completeMfa(auth, challenge, currentCode(clock)).catch(
        (error: unknown) => error,
      );
      expect(thrown).toBe(down);
    }
    expect(await adapter.listSessions(userId)).toHaveLength(0);

    reachable = true;
    const result = await completeMfa(auth, challenge, currentCode(clock));
    expect(result.session.mfaSatisfied).toBe(true);
  });
});

describe('defineAuth reads a guard before it trusts one', () => {
  test('a guard written for the old shape is refused, naming the key', () => {
    // `isUsed`/`remember` could not be made atomic across a network: a guard still shaped that way
    // has no answer to give, and finding out at the first second factor is a production lockout.
    const legacy = { isUsed: () => false, remember: () => undefined };
    let refusal: { code?: string; cause?: string; fix?: string } | undefined;
    try {
      defineAuth({
        adapter: memoryAuthAdapter(),
        totpReplay: legacy as unknown as TotpReplayGuard,
      });
    } catch (error) {
      refusal = error as { code?: string; cause?: string; fix?: string };
    }
    expect(refusal?.code).toBe('X_CONFIG_INVALID');
    expect(refusal?.cause).toContain('totpReplay');
    expect(refusal?.fix).toContain('claim(subject, step, at)');
  });
});
