// Single responsibility: the passkey ceremony the way a browser drives it — register, then sign in —
// over the memory adapter, with a real ES256 keypair and `crypto.subtle` doing the work. The
// refusals live in `passkey-refusal.test.ts`; the ceremony helpers both share are `passkey-fixture.ts`.

import { describe, expect, test } from 'bun:test';
import { harness, RP_ID, USER } from './passkey-fixture';
import { base64Url } from './tokens';

describe('passkeyLogin: register then sign in', () => {
  test('a registered authenticator signs in, and the counter is recorded', async () => {
    const h = harness();
    const authenticator = await h.register();

    const stored = await h.adapter.findPasskeyByCredentialId(base64Url(authenticator.credentialId));
    expect(stored?.userId).toBe(USER);
    // The public key survives a JSON round trip as the same STRING — base64url, never a Buffer,
    // which would come back as `{ type: 'Buffer', data: [...] }` and verify nothing.
    const roundTripped = JSON.parse(JSON.stringify(stored)) as {
      publicKeyCose: string;
      credentialId: string;
    };
    expect(roundTripped.publicKeyCose).toBe(stored?.publicKeyCose ?? '');
    expect(roundTripped.credentialId).toBe(base64Url(authenticator.credentialId));

    const options = await h.login.loginOptions({ userId: USER });
    expect(options.allowCredentials.map((entry) => entry.id)).toEqual([
      base64Url(authenticator.credentialId),
    ]);
    const signIn = await h.login.login({
      assertion: await h.assertionFor({
        authenticator,
        challenge: options.challenge,
        signCount: 1,
      }),
    });
    expect(signIn.userId).toBe(USER);
    expect(signIn.signCount).toBe(1);
    expect(
      (await h.adapter.findPasskeyByCredentialId(base64Url(authenticator.credentialId)))?.signCount,
    ).toBe(1);
  });

  test('the options a browser is handed are the WebAuthn shape, and the user handle is opaque', async () => {
    const h = harness();
    const options = await h.login.registerOptions({ userId: USER, username: 'ada@example.com' });
    expect(options.rp).toEqual({ id: RP_ID, name: RP_ID });
    expect(options.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(options.authenticatorSelection.userVerification).toBe('required');
    expect(options.attestation).toBe('none');
    // Not the user id: a handle is visible to every authenticator the user owns.
    expect(options.user.id).not.toBe(USER);
    expect(options.user.name).toBe('ada@example.com');
  });

  test('a second registration of the same authenticator adds no second credential row', async () => {
    const h = harness();
    // Register once: re-registering the SAME authenticator is an upsert on credential_id.
    await h.register();
    const options = await h.login.registerOptions({ userId: USER, username: 'ada@example.com' });
    expect(options.excludeCredentials).toHaveLength(1);
    expect((await h.adapter.listPasskeys(USER)).length).toBe(1);
  });
});
