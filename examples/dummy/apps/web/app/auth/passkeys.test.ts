/**
 * Postly's passkey adoption, as the app declares it: the relying party derives from `APP_URL`, an
 * unusable origin refuses at definition, and an irreversible erasure enqueues NOTHING without an
 * owner's passkey approval for exactly that member. The whole ceremony runs on Postly's own
 * declaration with a software passkey (`softAuthenticator`): real WebCrypto keys, the real verifier.
 */

import { spyOn } from 'bun:test';
import { memoryAuthAdapter } from '@ultimat3/auth';
import { softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import { frozenClock } from '@ultimat3/core';
import { expect, test, unitTest } from '@ultimat3/testing';
import { requestMemberErasure } from '../settings/actions/request-member-erasure';
import { eraseMember } from '../settings/jobs/erase-member';
import { passkeySignIn } from './actions/passkey-sign-in';
import { postlyAuth, postlyRelyingParty } from './login';
import { postlyPasskeys } from './passkeys';

const ADA = '00000000-0000-7000-8000-00000000ada0';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000b1';
const ERASURE = { orgId: ORG, memberId: MEMBER };

unitTest('the relying party is APP_URL: its origin, and its host as the rp id', () => {
  expect(postlyRelyingParty('https://postly.example:8443')).toEqual({
    rpId: 'postly.example',
    origins: ['https://postly.example:8443'],
  });
  const auth = postlyAuth({ adapter: memoryAuthAdapter(), origin: 'http://localhost:3000' });
  expect(auth.passkeys?.rpId).toBe('localhost');
});

unitTest(
  'a loopback IP origin boots on a localhost relying party instead of refusing the app',
  () => {
    // `x drill` serves on 127.0.0.1; `defineAuth` refuses an IP rp id, and that refusal was every
    // role failing to load.
    expect(postlyRelyingParty('http://127.0.0.1:4100')).toEqual({
      rpId: 'localhost',
      origins: ['http://localhost:4100'],
    });
    expect(
      postlyAuth({ adapter: memoryAuthAdapter(), origin: 'http://[::1]:4100' }).passkeys?.rpId,
    ).toBe('localhost');
  },
);

unitTest('an APP_URL WebAuthn cannot run on is refused where Postly declares its auth', () => {
  // An IP is never an rp id, and plain http runs WebAuthn on localhost only: refused at boot,
  // never at the first sign-in in production.
  for (const origin of ['http://10.0.0.7:3000', 'http://postly.example']) {
    expect(() => postlyAuth({ adapter: memoryAuthAdapter(), origin })).toThrow(
      expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
    );
  }
});

unitTest('an erasure approval needs a passkey the owner holds, and a real proof', async () => {
  const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
  const adapter = memoryAuthAdapter(clock);
  await adapter.createUser({
    id: ADA,
    email: 'ada@postly.example',
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: clock.now(),
  });
  const auth = postlyAuth({ adapter, clock, origin: 'http://localhost:3000' });
  const { erasure } = postlyPasskeys(auth);
  // No passkey registered yet: nothing to sign with, said as the step-up being owed.
  await expect(erasure.options({ userId: ADA, input: ERASURE })).rejects.toBeUltimateError(
    'X_PASSKEY_STEP_UP_REQUIRED',
  );
  await expect(
    erasure.verify({ userId: ADA, input: ERASURE, response: null }),
  ).rejects.toBeUltimateError('X_PASSKEY_STEP_UP_REQUIRED');
  await expect(
    erasure.verify({ userId: ADA, input: ERASURE, response: { type: 'public-key' } }),
  ).rejects.toBeUltimateError('X_PASSKEY_INVALID');
});

test('requestMemberErasure enqueues nothing without an approval', async ({ seed, actorFor }) => {
  const enqueue = spyOn(eraseMember, 'enqueue');
  try {
    const { owner, member } = await seed('dev').pick({
      owner: 'member:ada',
      member: 'member:bruno',
    });
    const input = { orgId: member.orgId, memberId: member.id, approval: null };
    await expect(requestMemberErasure.as(actorFor(owner), input)).rejects.toBeUltimateError(
      'X_PASSKEY_STEP_UP_REQUIRED',
    );
    expect(enqueue).not.toHaveBeenCalled();
  } finally {
    enqueue.mockRestore();
  }
});

unitTest('a forged sign-in response is a coded refusal, never a crash', async () => {
  const forged = { type: 'public-key', id: 'AA', rawId: 'AA', response: {} };
  await expect(passkeySignIn.as(null, { response: forged })).rejects.toBeUltimateError(
    'X_PASSKEY_INVALID',
  );
});

unitTest('a real passkey registers, signs in, and approves exactly one erasure', async () => {
  // Postly's own declaration over the memory adapter — the unit suite has no Postgres, and the
  // actions' wiring is what `x exercise` reaches with this same authenticator (`exercise.ts`).
  const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
  const adapter = memoryAuthAdapter(clock);
  await adapter.createUser({
    id: ADA,
    email: 'ada@postly.example',
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: clock.now(),
  });
  const origin = 'http://localhost:3000';
  const { login, erasure } = postlyPasskeys(postlyAuth({ adapter, clock, origin }));
  const device = await softAuthenticator({ origin });

  const creation = await login.registerOptions({ userId: ADA });
  const stored = await login.register({ userId: ADA, response: await device.create(creation) });
  expect(stored.id).toBe(device.credentialId);

  const signedIn = await login.login({ response: await device.get(await login.loginOptions()) });
  expect(signedIn.actor.id).toBe(ADA);

  // A real approval for this member, presented for another: a proof for other bytes is no proof.
  const other = { orgId: ORG, memberId: '00000000-0000-4000-8000-0000000000b2' };
  const misspent = await device.get(await erasure.options({ userId: ADA, input: ERASURE }));
  await expect(
    erasure.verify({ userId: ADA, input: other, response: misspent }),
  ).rejects.toBeUltimateError('X_PASSKEY_STEP_UP_REQUIRED');

  const approval = await device.get(await erasure.options({ userId: ADA, input: ERASURE }));
  const evidence = await erasure.verify({ userId: ADA, input: ERASURE, response: approval });
  expect(evidence.credentialId).toBe(device.credentialId);
  // Spent: the same approval twice is a challenge already taken.
  await expect(
    erasure.verify({ userId: ADA, input: ERASURE, response: approval }),
  ).rejects.toBeUltimateError('X_PASSKEY_CHALLENGE_EXPIRED');
});
