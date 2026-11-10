// The `IdentityProvider` contract of `@ultimat3/auth` as shared examples:
// `behavesLike(identityProviderConformance, () => harness)`. The harness plays the IdP (answers a
// redirect, tampers with an answer); every adapter must issue a fresh state per begin, prove one
// profile from an honest answer, and refuse a replayed, tampered or cross-wired one with a code.

import { expect, test } from 'bun:test';
import type { IdentityProvider, IdentityRedirect, VerifiedIdentity } from '@ultimat3/auth';
import { memoryTotpReplayGuard, type TotpReplayGuard } from '@ultimat3/auth';
import { type Clock, isUltimateError } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface IdentityProviderHarness {
  readonly provider: IdentityProvider;
  /** The URL `begin` and `complete` are given: what the IdP is registered to answer. */
  readonly callbackUrl: string;
  readonly clock: Clock;
  /** Play the IdP: the callback params a consenting user's browser would bring back. */
  answer(redirect: IdentityRedirect): Promise<Readonly<Record<string, string>>>;
  /** The same answer with its proof altered — a changed signed value, a forged state. */
  tamper(params: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
}

export interface IdentityProviderCheck {
  readonly name: string;
  run(harness: IdentityProviderHarness): Promise<void>;
}

const complete = (
  harness: IdentityProviderHarness,
  state: string,
  params: Readonly<Record<string, string>>,
  replay: TotpReplayGuard,
): Promise<VerifiedIdentity> =>
  harness.provider.complete({
    state,
    params,
    callbackUrl: harness.callbackUrl,
    clock: harness.clock,
    replay,
  });

/** A refusal must be coded: an `X_*` an operator can look up, never a bare throw. */
async function expectCodedRefusal(call: Promise<unknown>): Promise<void> {
  const outcome = await call.then(
    () => 'accepted',
    (error: unknown) =>
      isUltimateError(error) && /^X_[A-Z0-9_]+$/.test(error.code) ? 'coded' : 'uncoded',
  );
  expect(outcome).toBe('coded');
}

const begin = (harness: IdentityProviderHarness): Promise<IdentityRedirect> =>
  harness.provider.begin({ callbackUrl: harness.callbackUrl, clock: harness.clock });

export const IDENTITY_PROVIDER_CHECKS: readonly IdentityProviderCheck[] = [
  {
    name: 'declares a cookie-safe id and a callback method matching its protocol',
    async run({ provider }) {
      expect(provider.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(provider.callbackMethod).toBe(provider.protocol === 'saml' ? 'POST' : 'GET');
    },
  },
  {
    name: 'begin redirects to an absolute URL with a fresh state every time',
    async run(harness) {
      const [a, b] = [await begin(harness), await begin(harness)];
      expect(URL.canParse(a.location)).toBe(true);
      expect(a.state).not.toBe('');
      expect(a.state).not.toBe(b.state);
    },
  },
  {
    name: 'an honest answer completes to one profile under the provider id',
    async run(harness) {
      const redirect = await begin(harness);
      const identity = await complete(
        harness,
        redirect.state,
        await harness.answer(redirect),
        memoryTotpReplayGuard(),
      );
      expect(identity.profile.provider).toBe(harness.provider.id);
      expect(identity.profile.providerAccountId).not.toBe('');
      expect(identity.profile.emailVerified && identity.profile.email === null).toBe(false);
    },
  },
  {
    name: 'the same answer completes once; the second is a coded refusal',
    async run(harness) {
      const replay = memoryTotpReplayGuard();
      const redirect = await begin(harness);
      const params = await harness.answer(redirect);
      await complete(harness, redirect.state, params, replay);
      await expectCodedRefusal(complete(harness, redirect.state, params, replay));
    },
  },
  {
    name: 'a tampered answer is a coded refusal',
    async run(harness) {
      const redirect = await begin(harness);
      const params = harness.tamper(await harness.answer(redirect));
      await expectCodedRefusal(complete(harness, redirect.state, params, memoryTotpReplayGuard()));
    },
  },
  {
    name: "an answer to one begin, completed with another begin's state, is a coded refusal",
    async run(harness) {
      const [first, second] = [await begin(harness), await begin(harness)];
      const params = await harness.answer(first);
      await expectCodedRefusal(complete(harness, second.state, params, memoryTotpReplayGuard()));
    },
  },
  {
    name: 'answers() binds an answer to the state it was begun with, and to no other',
    async run(harness) {
      const [first, second] = [await begin(harness), await begin(harness)];
      const params = await harness.answer(first);
      expect(harness.provider.answers(first.state, params)).toBe(true);
      expect(harness.provider.answers(second.state, params)).toBe(false);
      expect(harness.provider.answers('{"forged":true}', params)).toBe(false);
    },
  },
  {
    name: 'a state the provider never issued is a coded refusal',
    async run(harness) {
      const redirect = await begin(harness);
      const params = await harness.answer(redirect);
      await expectCodedRefusal(
        complete(harness, '{"forged":true}', params, memoryTotpReplayGuard()),
      );
    },
  },
];

export const identityProviderConformance: SharedExamples<
  IdentityProviderHarness | Promise<IdentityProviderHarness>
> = sharedExamples('an identity provider', (subject) => {
  for (const check of IDENTITY_PROVIDER_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
