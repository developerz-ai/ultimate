// Single responsibility: digest-bound step-up — a passkey ceremony whose verified result is EVIDENCE
// for exactly one request, and a guard that refuses any other. Sign-in is `passkey.ts`; this file
// adds the binding (a digest the SERVER computes, never the client) and the evidence row that
// outlives the ceremony, so a guarded surface checks once and acts on the evidence.
//
// Two clocks, and they are different things. `ttlMs` bounds how long the EVIDENCE is good for, and
// its expiry is the one refusal a caller retries with nothing else changed. The ceremony's own
// challenge ttl bounds one browser prompt. Both are read through `auth.clock`, never `Date.now()`.
//
// WHERE THE INDEX LIVES. `PasskeyStore` reads evidence by id, so this keeps digest → assertion ids
// in a bounded in-process map, exactly as the challenge registry in `passkey.ts` does. The ROWS are
// the store's and any process can read them back by id with the digest on them — which is what makes
// the evidence auditable by a second process. The map only saves a scan; two replicas simply do not
// share the shortcut.
//
// `putPasskeyAssertion` collides on id, never on digest: two ceremonies over one request are two
// pieces of evidence, and collapsing them would keep whichever wrote last.

import { renderCauseValue, uuidV7 } from '@ultimat3/core';
import type { Auth } from './auth';
import type { PasskeyAssertionResponse } from './passkey';
import { passkeyLogin, verifySignIn } from './passkey';
import { passkeyConfigInvalid, passkeysOf } from './passkey-config';
import { passkeyChallengeExpired, passkeyStepUpRequired } from './passkey-errors';
import type { PasskeyAssertion } from './passkey-store';
import { assertFiniteAuthCount } from './policy-numbers';

/** A digest: base64url or hex, 16..128 characters. Anything else cannot be a challenge input. */
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** Bounded, so digests are not memory a caller chooses the size of. */
const EVIDENCE_INDEX_CAP = 10_000;

export interface PasskeyStepUpOptions {
  /** How long one verified assertion stays live as evidence. */
  readonly ttlMs: number;
  /**
   * The digest to bind, computed by the SERVER from the request it protects — the body it is about
   * to act on. The ceremony's challenge is derived from this string and the string is stored beside
   * the assertion, so a client cannot redirect an approval from one request to another.
   */
  readonly challenge: (input: { readonly input: { readonly requestDigest: string } }) => string;
}

/** One ceremony, from the options a browser needs to the instant its evidence would expire. */
export interface PasskeyStepUpCeremony {
  readonly challenge: string;
  readonly requestDigest: string;
  readonly expiresAt: Date;
}

export interface PasskeyStepUp {
  /** Start a ceremony for `userId` over `requestDigest`. Answers what the browser must sign. */
  readonly options: (input: {
    readonly userId: string;
    readonly requestDigest: string;
  }) => Promise<PasskeyStepUpCeremony>;
  /** Verify the answer, then record it as evidence for the digest its ceremony was opened over. */
  readonly verify: (input: {
    readonly userId: string;
    readonly assertion: PasskeyAssertionResponse;
  }) => Promise<PasskeyAssertion>;
  /**
   * The guard a privileged surface calls. `X_PASSKEY_STEP_UP_REQUIRED` when nothing covers this
   * digest; `X_PASSKEY_CHALLENGE_EXPIRED` when something did and its ttl has passed.
   */
  readonly guard: (input: {
    readonly userId: string;
    readonly requestDigest: string;
    readonly surface: string;
  }) => Promise<PasskeyAssertion>;
  /** Whether live evidence covers this digest, without raising a refusal. */
  readonly isLive: (input: {
    readonly userId: string;
    readonly requestDigest: string;
  }) => Promise<boolean>;
}

/** The index key: one digest per user, and `\u0000` cannot occur in either half. */
const keyOf = (userId: string, requestDigest: string): string => `${userId}\u0000${requestDigest}`;

export function passkeyStepUp(auth: Auth, options: PasskeyStepUpOptions): PasskeyStepUp {
  // Screened at the seam like every other number this package bounds: a `NaN` ttl makes `expiresAt`
  // an Invalid Date and `now >= NaN` is false — evidence that never expires is not evidence.
  const ttlMs = assertFiniteAuthCount(
    'passkeyStepUp.ttlMs',
    options.ttlMs,
    'expiresAt becomes an Invalid Date, `expiresAt <= now` is false, and one assertion would satisfy this digest forever',
    1,
  );
  const login = passkeyLogin(auth);
  /** digest → assertion ids, in insertion order. Bounded; the rows themselves live in the store. */
  const index = new Map<string, string[]>();

  const remember = (key: string, id: string): void => {
    while (index.size >= EVIDENCE_INDEX_CAP && !index.has(key)) {
      const oldest = index.keys().next();
      if (oldest.done === true) break;
      index.delete(oldest.value);
    }
    index.set(key, [...(index.get(key) ?? []), id]);
  };

  /** The stored rows for this user and digest, read back from the store — never from the caller. */
  const rowsFor = async (key: string): Promise<readonly PasskeyAssertion[]> => {
    const rows: PasskeyAssertion[] = [];
    for (const id of index.get(key) ?? []) {
      const row = await auth.adapter.findPasskeyAssertion(id);
      if (row !== null) rows.push(row);
    }
    return rows;
  };

  return {
    async options(input): Promise<PasskeyStepUpCeremony> {
      passkeysOf(auth);
      const digest = options.challenge({ input: { requestDigest: input.requestDigest } });
      if (!DIGEST_PATTERN.test(digest)) {
        throw passkeyConfigInvalid(
          'challenge',
          `answered ${renderCauseValue(digest)} for that request, which cannot be a challenge: a step-up challenge is derived from the request digest so that the authenticator signs the request the server will act on`,
          'passkeyStepUp: { challenge: ({ input }) => input.requestDigest }   # a base64url or hex digest, 16..128 chars',
        );
      }
      // The digest is stored on the ceremony record, and `verify` reads it back from there — so the
      // client cannot name the request its assertion approves.
      const issued = await login.loginOptions({
        userId: input.userId,
        requestDigest: input.requestDigest,
        challenge: digest,
      });
      return {
        challenge: issued.challenge,
        requestDigest: input.requestDigest,
        expiresAt: new Date(auth.clock.now().getTime() + ttlMs),
      };
    },

    async verify(input): Promise<PasskeyAssertion> {
      // Through the same sign-in path `login()` uses, so the counter compare-and-set runs here too:
      // a step-up is not a second way to spend one authenticator counter.
      const verified = await verifySignIn(auth, input.assertion);
      const digest = verified.ceremony.requestDigest;
      if (verified.userId !== input.userId || digest === '') {
        throw passkeyStepUpRequired({
          surface: 'passkeyStepUp.verify',
          digest: digest === '' ? input.userId : digest,
        });
      }
      const evidence = await auth.adapter.putPasskeyAssertion({
        id: uuidV7(auth.clock),
        userId: verified.userId,
        credentialId: verified.credential.credentialId,
        challenge: digest,
        requestDigest: digest,
        clientDataJson: verified.clientDataJson,
        authenticatorData: verified.authenticatorData,
        signature: verified.signature,
        verifiedAt: verified.verifiedAt,
        expiresAt: new Date(verified.verifiedAt.getTime() + ttlMs),
      });
      remember(keyOf(verified.userId, digest), evidence.id);
      return evidence;
    },

    async guard(input): Promise<PasskeyAssertion> {
      const now = auth.clock.now().getTime();
      const rows = await rowsFor(keyOf(input.userId, input.requestDigest));
      const live = rows.find((row) => row.expiresAt.getTime() > now);
      if (live !== undefined) return live;
      // A row that exists but ran out is a different answer from no row at all, and it is the one a
      // caller can act on — so it gets its own code rather than the same refusal as "never approved".
      const expired = rows.find((row) => row.expiresAt.getTime() <= now);
      if (expired !== undefined) {
        throw passkeyChallengeExpired({ purpose: input.surface, expiredAt: expired.expiresAt });
      }
      throw passkeyStepUpRequired({ surface: input.surface, digest: input.requestDigest });
    },

    async isLive(input): Promise<boolean> {
      const now = auth.clock.now().getTime();
      const rows = await rowsFor(keyOf(input.userId, input.requestDigest));
      return rows.some((row) => row.expiresAt.getTime() > now);
    },
  };
}
