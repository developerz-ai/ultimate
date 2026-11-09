// `passkeyLogin(auth)` end to end on real WebCrypto signatures: a software authenticator registers
// and signs in, and every attack the verifier exists for is one test — a forged signature, a
// replayed or expired challenge, another origin, another rp id, no user verification, a cloned
// authenticator's counter, one account's challenge spent registering onto another.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Auth } from './auth';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { memoryAuthAdapter } from './memory-adapter';
import { flipByte } from './passkey-fixture';
import { passkeyLogin } from './passkey-login';
import { softAuthenticator } from './soft-authenticator';
import { FLAG_AT, FLAG_UP, FLAG_UV } from './webauthn-data';

const ORIGIN = 'https://app.example.com';
const USER_ID = '00000000-0000-7000-8000-000000000990';
const OTHER_ID = '00000000-0000-7000-8000-000000000991';

const setup = async (algorithm: 'ES256' | 'RS256' = 'ES256', counter: number | null = 0) => {
  const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
  const adapter = memoryAuthAdapter(clock);
  const auth: Auth = defineAuth({
    adapter,
    clock,
    passkeys: { rpId: 'example.com', origins: [ORIGIN] },
  });
  for (const [id, email] of [
    [USER_ID, 'ada@example.com'],
    [OTHER_ID, 'grace@example.com'],
  ] as const) {
    await adapter.createUser({
      id,
      email,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: clock.now(),
    });
  }
  const passkeys = passkeyLogin(auth);
  const device = await softAuthenticator({ origin: ORIGIN, algorithm, counter });
  return { auth, adapter, clock, passkeys, device };
};

const registered = async (algorithm: 'ES256' | 'RS256' = 'ES256', counter: number | null = 0) => {
  const world = await setup(algorithm, counter);
  const options = await world.passkeys.registerOptions({ userId: USER_ID });
  await world.passkeys.register({ userId: USER_ID, response: await world.device.create(options) });
  return world;
};

describe('registration', () => {
  test('a real ES256 attestation stores the credential under the user', async () => {
    const { adapter, device } = await registered();
    const stored = await adapter.findPasskey(device.credentialId);
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.algorithm).toBe(-7);
    expect(stored?.transports).toEqual(['internal', 'hybrid']);
  });

  test('a real RS256 attestation is accepted too', async () => {
    const { adapter, device } = await registered('RS256');
    expect((await adapter.findPasskey(device.credentialId))?.algorithm).toBe(-257);
  });

  test('options ask for a resident, user-verified key and exclude what is registered', async () => {
    const { passkeys, device } = await registered();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    expect(options.authenticatorSelection.userVerification).toBe('required');
    expect(options.rp.id).toBe('example.com');
    expect(options.excludeCredentials.map((row) => row.id)).toEqual([device.credentialId]);
    expect(options.pubKeyCredParams.map((row) => row.alg)).toEqual([-7, -257]);
  });

  test("one account's challenge cannot register a key onto another", async () => {
    const { passkeys, device } = await setup();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    const error = await caught(async () =>
      passkeys.register({ userId: OTHER_ID, response: await device.create(options) }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
  });

  test('a registration replayed after it succeeded finds no challenge', async () => {
    const { passkeys, device } = await setup();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    const response = await device.create(options);
    await passkeys.register({ userId: USER_ID, response });
    const error = await caught(() => passkeys.register({ userId: USER_ID, response }));
    expect(error?.code).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });

  test.each([
    ['another origin', { origin: 'https://evil.example.net' }],
    ['another rp id', { rpId: 'evil.example' }],
    ['no user verification', { flags: FLAG_UP | FLAG_AT }],
    ['no user presence', { flags: FLAG_UV | FLAG_AT }],
    ['the get ceremony type', { type: 'webauthn.get' }],
    ['a cross-origin iframe', { crossOrigin: true }],
  ])('refuses %s', async (_name, overrides) => {
    const { passkeys, device, adapter } = await setup();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    const error = await caught(async () =>
      passkeys.register({ userId: USER_ID, response: await device.create(options, overrides) }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
    expect(await adapter.findPasskey(device.credentialId)).toBeNull();
  });

  test('a tampered attestation object is refused', async () => {
    const { passkeys, device } = await setup();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    const response = await device.create(options);
    const tampered = {
      ...response,
      response: {
        ...response.response,
        attestationObject: flipByte(response.response.attestationObject, 40),
      },
    };
    const error = await caught(() => passkeys.register({ userId: USER_ID, response: tampered }));
    expect(error?.code).toBe('X_PASSKEY_INVALID');
  });

  test('an expired challenge is refused', async () => {
    const { passkeys, device, clock } = await setup();
    const options = await passkeys.registerOptions({ userId: USER_ID });
    clock.advance(5 * 60_000);
    const error = await caught(async () =>
      passkeys.register({ userId: USER_ID, response: await device.create(options) }),
    );
    expect(error?.code).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });
});

describe('sign-in', () => {
  test('a real assertion mints an MFA-satisfied session for the owner', async () => {
    const { passkeys, device } = await registered();
    const options = await passkeys.loginOptions();
    expect(options.allowCredentials).toEqual([]);
    const result = await passkeys.login({ response: await device.get(options) });
    expect(result.actor.id).toBe(USER_ID);
    expect(result.session.mfaSatisfied).toBe(true);
    expect(result.cookie).toContain(result.token);
  });

  test('RS256 signs in too', async () => {
    const { passkeys, device } = await registered('RS256');
    const result = await passkeys.login({
      response: await device.get(await passkeys.loginOptions()),
    });
    expect(result.actor.id).toBe(USER_ID);
  });

  test('a forged signature is refused, and the challenge is spent', async () => {
    const { passkeys, device } = await registered();
    const response = await device.get(await passkeys.loginOptions());
    const forged = {
      ...response,
      response: { ...response.response, signature: flipByte(response.response.signature, 10) },
    };
    expect((await caught(() => passkeys.login({ response: forged })))?.code).toBe(
      'X_PASSKEY_INVALID',
    );
    expect((await caught(() => passkeys.login({ response })))?.code).toBe(
      'X_PASSKEY_CHALLENGE_EXPIRED',
    );
  });

  test('tampered client data breaks the signature', async () => {
    const { passkeys, device } = await registered();
    const options = await passkeys.loginOptions();
    const genuine = await device.get(options);
    const other = await device.get(options, { origin: ORIGIN, signCount: 99 });
    // Signed authenticatorData from one assertion, client data from another: neither signature covers it.
    const spliced = {
      ...genuine,
      response: { ...genuine.response, authenticatorData: other.response.authenticatorData },
    };
    expect((await caught(() => passkeys.login({ response: spliced })))?.code).toBe(
      'X_PASSKEY_INVALID',
    );
  });

  test('a replayed assertion finds no challenge', async () => {
    const { passkeys, device } = await registered();
    const response = await device.get(await passkeys.loginOptions());
    await passkeys.login({ response });
    expect((await caught(() => passkeys.login({ response })))?.code).toBe(
      'X_PASSKEY_CHALLENGE_EXPIRED',
    );
  });

  test('a challenge the server never issued is refused', async () => {
    const { passkeys, device } = await registered();
    const options = await passkeys.loginOptions();
    const response = await device.get({
      ...options,
      challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect((await caught(() => passkeys.login({ response })))?.code).toBe(
      'X_PASSKEY_CHALLENGE_EXPIRED',
    );
  });

  test('an expired challenge is refused', async () => {
    const { passkeys, device, clock } = await registered();
    const options = await passkeys.loginOptions();
    clock.advance(5 * 60_000);
    expect(
      (await caught(async () => passkeys.login({ response: await device.get(options) })))?.code,
    ).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });

  test.each([
    ['another origin', { origin: 'https://example.com.evil.net' }],
    ['another rp id', { rpId: 'evil.example' }],
    ['no user verification', { flags: FLAG_UP }],
    ['the create ceremony type', { type: 'webauthn.create' }],
    ['a user handle naming someone else', { userHandle: btoa(OTHER_ID).replaceAll('=', '') }],
  ])('refuses %s', async (_name, overrides) => {
    const { passkeys, device } = await registered();
    const options = await passkeys.loginOptions();
    expect(
      (await caught(async () => passkeys.login({ response: await device.get(options, overrides) })))
        ?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test('a counter that does not move forward is a cloned authenticator', async () => {
    const { passkeys, device } = await registered();
    await passkeys.login({
      response: await device.get(await passkeys.loginOptions(), { signCount: 5 }),
    });
    const options = await passkeys.loginOptions();
    expect(
      (
        await caught(async () =>
          passkeys.login({ response: await device.get(options, { signCount: 5 }) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
    const again = await passkeys.loginOptions();
    expect(
      (
        await caught(async () =>
          passkeys.login({ response: await device.get(again, { signCount: 3 }) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test('an authenticator that keeps no counter (always 0) signs in every time', async () => {
    const { passkeys, device } = await registered('ES256', null);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await passkeys.login({
        response: await device.get(await passkeys.loginOptions()),
      });
      expect(result.actor.id).toBe(USER_ID);
    }
  });

  test('an unregistered credential is refused', async () => {
    const { passkeys } = await registered();
    const stranger = await softAuthenticator({ origin: ORIGIN });
    expect(
      (
        await caught(async () =>
          passkeys.login({ response: await stranger.get(await passkeys.loginOptions()) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test('a disabled user cannot sign in with a valid passkey', async () => {
    const { passkeys, device, adapter, clock } = await registered();
    await adapter.updateUser(USER_ID, { disabledAt: clock.now() });
    expect(
      (
        await caught(async () =>
          passkeys.login({ response: await device.get(await passkeys.loginOptions()) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test.each([
    null,
    'nope',
    {},
    { type: 'public-key', id: 'a', rawId: 'b', response: {} },
    { type: 'public-key', id: 'a+', rawId: 'a+', response: {} },
  ])('a malformed response %p is X_PASSKEY_INVALID, never a crash', async (response) => {
    const { passkeys } = await registered();
    expect((await caught(() => passkeys.login({ response })))?.code).toBe('X_PASSKEY_INVALID');
  });
});

test('passkeyLogin on an Auth with no passkeys block is X_CONFIG_INVALID at definition', async () => {
  const auth = defineAuth({ adapter: memoryAuthAdapter() });
  expect((await caught(async () => passkeyLogin(auth)))?.code).toBe('X_CONFIG_INVALID');
});
