// Single responsibility: every way the passkey ceremony REFUSES. Each case is a ceremony that would
// succeed but for the single input it names, so removing the check under test turns this file red
// rather than green. The happy path is `passkey.test.ts`; the shared ceremony is `passkey-fixture.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { memoryAuthAdapter } from './memory-adapter';
import { PASSKEY_CHALLENGE_TTL_MS, passkeyLogin } from './passkey';
import {
  authenticatorData,
  clientDataOf,
  encoder,
  FLAG_UP,
  FLAG_UV,
  harness,
  newAuthenticator,
  ORIGIN,
  RP_ID,
  signedBytes,
  signWith,
  USER,
} from './passkey-fixture';
import { base64Url } from './tokens';

/**
 * Every refusal below is proven by a ceremony that WOULD succeed but for the one thing it names:
 * each case builds a valid assertion and changes exactly one input. Without the check, the
 * `expect.unreachable()` is what fails — so a suite that only accepted the happy path would pass
 * with the verification deleted, and this one would not.
 */
describe('passkeyLogin refuses a ceremony that is not the one it issued', () => {
  test('a challenge replayed from an earlier ceremony is refused', async () => {
    const h = harness();
    const authenticator = await h.register();
    const first = await h.login.loginOptions({ userId: USER });
    await h.login.login({
      assertion: await h.assertionFor({ authenticator, challenge: first.challenge, signCount: 1 }),
    });

    // A SECOND answer to the same challenge, freshly signed and with a counter ABOVE the stored one —
    // so the clone check passes and the signature verifies. Consumption is the only thing left that
    // can refuse it; with `pending.delete` removed this call succeeds.
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: first.challenge,
          signCount: 2,
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('replay');
    // Nothing moved: it was refused before any write.
    expect(
      (await h.adapter.findPasskeyByCredentialId(base64Url(authenticator.credentialId)))?.signCount,
    ).toBe(1);
  });

  test('a tampered signature is refused, and the untampered twin succeeds', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: options.challenge,
          signCount: 1,
          tamper: true,
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('signature');

    // Same everything, flipped back: the only difference is the bit the check reads.
    const fresh = await h.login.loginOptions({ userId: USER });
    const signed = await h.login.login({
      assertion: await h.assertionFor({ authenticator, challenge: fresh.challenge, signCount: 1 }),
    });
    expect(signed.userId).toBe(USER);
  });

  test('a signature over the WRONG buffer is refused — signing is not proof by itself', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    const clientDataJSON = clientDataOf({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: ORIGIN,
    });
    const authData = authenticatorData({ rpId: RP_ID, flags: FLAG_UP | FLAG_UV, signCount: 1 });
    // Right key, right shapes — signed over authenticatorData ALONE, without the client-data hash.
    const signature = await signWith(authenticator.key, authData);
    const error = await caught(async () =>
      h.login.login({
        assertion: {
          id: base64Url(authenticator.credentialId),
          rawId: base64Url(authenticator.credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
            authenticatorData: base64Url(authData),
            signature: base64Url(signature),
          },
        },
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
  });

  test('a foreign origin is refused', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: options.challenge,
          signCount: 1,
          origin: 'https://evil.test',
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('evil.test');
  });

  test('a subdomain origin the config lists is accepted — origin is checked, not merely present', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    const signed = await h.login.login({
      assertion: await h.assertionFor({
        authenticator,
        challenge: options.challenge,
        signCount: 1,
        origin: 'https://app.example.com',
      }),
    });
    expect(signed.userId).toBe(USER);
  });

  test('a sign count that goes backwards is refused', async () => {
    const h = harness();
    const authenticator = await h.register();
    const first = await h.login.loginOptions({ userId: USER });
    await h.login.login({
      assertion: await h.assertionFor({ authenticator, challenge: first.challenge, signCount: 5 }),
    });

    // A cloned authenticator replays an OLD counter under a FRESH challenge: the challenge check
    // cannot catch it, so `updatePasskeyUsage`'s compare-and-set is the only thing that does.
    const second = await h.login.loginOptions({ userId: USER });
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: second.challenge,
          signCount: 4,
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('counter');
    // The stored counter is untouched by the refused write.
    expect(
      (await h.adapter.findPasskeyByCredentialId(base64Url(authenticator.credentialId)))?.signCount,
    ).toBe(5);
  });

  test('a challenge answered after its ttl is refused as expired, on an advanced clock', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    // Advance past the ceremony's own ttl — no sleep, and no recomputed `Date.now()`.
    h.clock.advance(PASSKEY_CHALLENGE_TTL_MS + 1);
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: options.challenge,
          signCount: 1,
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });

  test('an unregistered credential is refused, and never as a 500', async () => {
    const h = harness();
    const authenticator = await newAuthenticator();
    const options = await h.login.loginOptions({ userId: USER });
    const error = await caught(async () =>
      h.login.login({
        assertion: await h.assertionFor({
          authenticator,
          challenge: options.challenge,
          signCount: 1,
        }),
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('no passkey is registered');
  });

  test('a create ceremony answered as a sign-in is refused', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.registerOptions({ userId: USER, username: 'ada@example.com' });
    const clientDataJSON = clientDataOf({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: ORIGIN,
    });
    const authData = authenticatorData({ rpId: RP_ID, flags: FLAG_UP | FLAG_UV, signCount: 1 });
    const error = await caught(async () =>
      h.login.login({
        assertion: {
          id: base64Url(authenticator.credentialId),
          rawId: base64Url(authenticator.credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
            authenticatorData: base64Url(authData),
            signature: base64Url(
              await signWith(authenticator.key, signedBytes(authData, clientDataJSON)),
            ),
          },
        },
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
  });

  test('a rpIdHash for another relying party is refused', async () => {
    const h = harness();
    const authenticator = await h.register();
    const options = await h.login.loginOptions({ userId: USER });
    const clientDataJSON = clientDataOf({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: ORIGIN,
    });
    // Everything valid EXCEPT the rpIdHash: a credential enrolled at a different site.
    const authData = authenticatorData({
      rpId: 'evil.test',
      flags: FLAG_UP | FLAG_UV,
      signCount: 1,
    });
    const error = await caught(async () =>
      h.login.login({
        assertion: {
          id: base64Url(authenticator.credentialId),
          rawId: base64Url(authenticator.credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
            authenticatorData: base64Url(authData),
            signature: base64Url(
              await signWith(authenticator.key, signedBytes(authData, clientDataJSON)),
            ),
          },
        },
      }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(error?.cause).toContain('rpIdHash');
  });

  test('a passkey call on an app that declared no passkeys is a config refusal, not a ceremony', async () => {
    const clock = frozenClock('2026-11-06T00:00:00.000Z');
    const auth = defineAuth({ adapter: memoryAuthAdapter(clock), clock });
    const error = await caught(async () =>
      passkeyLogin(auth).registerOptions({ userId: USER, username: 'ada@example.com' }),
    );
    expect(error?.code).toBe('X_CONFIG_INVALID');
  });
});
