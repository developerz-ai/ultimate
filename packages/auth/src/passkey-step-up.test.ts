// `passkeyStepUp(auth, { digest })`: a proof is bound to the bytes the SERVER derived from the
// input, single-use, user-verified, the acting user's own, and stored as evidence that a separate
// verifier — no adapter, no clock — re-checks; any edit to that row fails the re-check.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { PasskeyEvidence } from './adapter';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { base64Url } from './base64url';
import { memoryAuthAdapter } from './memory-adapter';
import { verifyPasskeyEvidence } from './passkey-evidence';
import { flipByte } from './passkey-fixture';
import { passkeyLogin } from './passkey-login';
import { passkeyStepUp } from './passkey-step-up';
import { softAuthenticator } from './soft-authenticator';
import { FLAG_UP } from './webauthn-data';

const ORIGIN = 'https://example.com';
const RP = { rpId: 'example.com', origins: [ORIGIN] } as const;
const ADA = '00000000-0000-7000-8000-000000000a01';
const GRACE = '00000000-0000-7000-8000-000000000a02';

interface Transfer {
  readonly to: string;
  readonly minor: number;
}

const setup = async () => {
  const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({ adapter, clock, passkeys: RP });
  for (const [id, email] of [
    [ADA, 'ada@example.com'],
    [GRACE, 'grace@example.com'],
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
  const login = passkeyLogin(auth);
  const enrol = async (userId: string) => {
    const device = await softAuthenticator({ origin: ORIGIN });
    await login.register({
      userId,
      response: await device.create(await login.registerOptions({ userId })),
    });
    return device;
  };
  const stepUp = passkeyStepUp<Transfer>(auth, {
    ttlMs: 60_000,
    digest: ({ input }) => `transfer:v1:${input.to}:${input.minor}`,
  });
  return { auth, adapter, clock, stepUp, enrol };
};

const transfer: Transfer = { to: 'acct-7', minor: 125_00 };

describe('passkeyStepUp', () => {
  test('a proof for this input verifies, is stored, and binds the exact digest', async () => {
    const { stepUp, enrol, adapter } = await setup();
    const device = await enrol(ADA);
    const options = await stepUp.options({ userId: ADA, input: transfer });
    expect(options.allowCredentials.map((row) => row.id)).toEqual([device.credentialId]);
    const evidence = await stepUp.verify({
      userId: ADA,
      input: transfer,
      response: await device.get(options),
    });
    expect(evidence.digest).toBe(base64Url(new TextEncoder().encode('transfer:v1:acct-7:12500')));
    expect(await adapter.listPasskeyEvidence(evidence.digest)).toEqual([evidence]);
  });

  test('no response at all is X_PASSKEY_STEP_UP_REQUIRED', async () => {
    const { stepUp, enrol } = await setup();
    await enrol(ADA);
    expect(
      (await caught(() => stepUp.verify({ userId: ADA, input: transfer, response: undefined })))
        ?.code,
    ).toBe('X_PASSKEY_STEP_UP_REQUIRED');
  });

  test('a proof approved for one input does not authorise another', async () => {
    const { stepUp, enrol } = await setup();
    const device = await enrol(ADA);
    const options = await stepUp.options({ userId: ADA, input: transfer });
    const response = await device.get(options);
    const error = await caught(() =>
      stepUp.verify({ userId: ADA, input: { ...transfer, minor: 999_999_00 }, response }),
    );
    expect(error?.code).toBe('X_PASSKEY_STEP_UP_REQUIRED');
    expect(error?.meta?.['missing']).toBe('other-digest');
  });

  test('a proof is single-use', async () => {
    const { stepUp, enrol } = await setup();
    const device = await enrol(ADA);
    const response = await device.get(await stepUp.options({ userId: ADA, input: transfer }));
    await stepUp.verify({ userId: ADA, input: transfer, response });
    expect(
      (await caught(() => stepUp.verify({ userId: ADA, input: transfer, response })))?.code,
    ).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });

  test('a proof older than ttlMs is expired', async () => {
    const { stepUp, enrol, clock } = await setup();
    const device = await enrol(ADA);
    const options = await stepUp.options({ userId: ADA, input: transfer });
    clock.advance(60_000);
    expect(
      (
        await caught(async () =>
          stepUp.verify({ userId: ADA, input: transfer, response: await device.get(options) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
  });

  test("another user's proof, or another user's passkey, never verifies as yours", async () => {
    const { stepUp, enrol } = await setup();
    const ada = await enrol(ADA);
    const grace = await enrol(GRACE);
    const forAda = await stepUp.options({ userId: ADA, input: transfer });
    expect(
      (
        await caught(async () =>
          stepUp.verify({ userId: GRACE, input: transfer, response: await ada.get(forAda) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
    const again = await stepUp.options({ userId: ADA, input: transfer });
    expect(
      (
        await caught(async () =>
          stepUp.verify({ userId: ADA, input: transfer, response: await grace.get(again) }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test('a challenge issued to one user, signed by another with their OWN passkey, is refused', async () => {
    const { stepUp, enrol } = await setup();
    await enrol(ADA);
    const grace = await enrol(GRACE);
    const forAda = await stepUp.options({ userId: ADA, input: transfer });
    const error = await caught(async () =>
      stepUp.verify({ userId: GRACE, input: transfer, response: await grace.get(forAda) }),
    );
    expect(error?.code).toBe('X_PASSKEY_INVALID');
  });

  test('a presence-only assertion (no user verification) is refused', async () => {
    const { stepUp, enrol } = await setup();
    const device = await enrol(ADA);
    const options = await stepUp.options({ userId: ADA, input: transfer });
    expect(
      (
        await caught(async () =>
          stepUp.verify({
            userId: ADA,
            input: transfer,
            response: await device.get(options, { flags: FLAG_UP }),
          }),
        )
      )?.code,
    ).toBe('X_PASSKEY_INVALID');
  });

  test('a user with no passkey cannot be asked for one', async () => {
    const { stepUp } = await setup();
    const error = await caught(() => stepUp.options({ userId: ADA, input: transfer }));
    expect(error?.code).toBe('X_PASSKEY_STEP_UP_REQUIRED');
    expect(error?.meta?.['missing']).toBe('no-passkey');
  });

  test('a digest callback answering nothing, or a payload, is X_CONFIG_INVALID', async () => {
    const { auth, enrol } = await setup();
    await enrol(ADA);
    for (const answer of ['', 'x'.repeat(1025)]) {
      const stepUp = passkeyStepUp<Transfer>(auth, { digest: () => answer });
      expect((await caught(() => stepUp.options({ userId: ADA, input: transfer })))?.code).toBe(
        'X_CONFIG_INVALID',
      );
    }
  });

  test.each([Number.NaN, 0, -1])('ttlMs %p is refused at definition', async (ttlMs) => {
    const { auth } = await setup();
    expect(
      (await caught(async () => passkeyStepUp(auth, { ttlMs, digest: () => 'd' })))?.code,
    ).toBe('X_CONFIG_INVALID');
  });
});

describe('verifyPasskeyEvidence — the separate process', () => {
  const evidenceOf = async (): Promise<PasskeyEvidence> => {
    const { stepUp, enrol } = await setup();
    const device = await enrol(ADA);
    const options = await stepUp.options({ userId: ADA, input: transfer });
    return await stepUp.verify({
      userId: ADA,
      input: transfer,
      response: await device.get(options),
    });
  };

  test('the stored row verifies on its own, through a JSON round trip', async () => {
    const evidence = await evidenceOf();
    const shipped: PasskeyEvidence = {
      ...JSON.parse(JSON.stringify(evidence)),
      createdAt: evidence.createdAt,
    };
    expect(await verifyPasskeyEvidence(shipped, RP)).toBe(true);
  });

  test.each([
    [
      'digest',
      (e: PasskeyEvidence) => ({
        ...e,
        digest: base64Url(new TextEncoder().encode('transfer:v1:acct-9:12500')),
      }),
    ],
    ['nonce', (e: PasskeyEvidence) => ({ ...e, nonce: flipByte(e.nonce) })],
    ['userId', (e: PasskeyEvidence) => ({ ...e, userId: GRACE })],
    ['signature', (e: PasskeyEvidence) => ({ ...e, signature: flipByte(e.signature, 12) })],
    [
      'authenticatorData',
      (e: PasskeyEvidence) => ({ ...e, authenticatorData: flipByte(e.authenticatorData, 36) }),
    ],
    [
      'clientDataJSON',
      (e: PasskeyEvidence) => ({ ...e, clientDataJSON: flipByte(e.clientDataJSON, 20) }),
    ],
  ])('an edited %s fails the re-check', async (_field, edit) => {
    expect(await verifyPasskeyEvidence(edit(await evidenceOf()), RP)).toBe(false);
  });

  test('another key fails the re-check', async () => {
    const first = await evidenceOf();
    const second = await evidenceOf();
    expect(await verifyPasskeyEvidence({ ...first, publicKey: second.publicKey }, RP)).toBe(false);
  });

  test('another relying party fails the re-check', async () => {
    const evidence = await evidenceOf();
    expect(
      await verifyPasskeyEvidence(evidence, {
        rpId: 'example.com',
        origins: ['https://other.example.com'],
      }),
    ).toBe(false);
    expect(await verifyPasskeyEvidence(evidence, { rpId: 'other.com', origins: [ORIGIN] })).toBe(
      false,
    );
  });
});
