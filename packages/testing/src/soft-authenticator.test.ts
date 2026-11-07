// `softAuthenticator`, as an app's test reaches it — off `@ultimat3/auth/soft-authenticator` — driving the real
// `passkeyLogin` / `passkeyStepUp` verifier end to end: register, sign in, approve one digest. The
// refusals prove the overrides reach the bytes the verifier checks, not a fake of them.

import { defineAuth, memoryAuthAdapter, passkeyLogin, passkeyStepUp } from '@ultimat3/auth';
import { softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import { frozenClock } from '@ultimat3/core';
import { expect, unitTest } from './index';

const ORIGIN = 'http://localhost:3000';
const ADA = '00000000-0000-7000-8000-00000000ada1';

const world = async () => {
  const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
  const adapter = memoryAuthAdapter(clock);
  await adapter.createUser({
    id: ADA,
    email: 'ada@example.test',
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: clock.now(),
  });
  const auth = defineAuth({
    adapter,
    clock,
    passkeys: { rpId: 'localhost', origins: [ORIGIN] },
  });
  const device = await softAuthenticator({ origin: ORIGIN });
  const login = passkeyLogin(auth);
  await login.register({
    userId: ADA,
    response: await device.create(await login.registerOptions({ userId: ADA })),
  });
  return { adapter, auth, device, login };
};

unitTest('a software passkey registers, signs in and approves one digest', async () => {
  const { adapter, auth, device, login } = await world();
  expect((await adapter.findPasskey(device.credentialId))?.userId).toBe(ADA);

  const signedIn = await login.login({ response: await device.get(await login.loginOptions()) });
  expect(signedIn.actor.id).toBe(ADA);

  const erase = passkeyStepUp<{ readonly memberId: string }>(auth, {
    digest: ({ input }) => `erase:${input.memberId}`,
  });
  const input = { memberId: 'm1' };
  const approval = await device.get(await erase.options({ userId: ADA, input }));
  const evidence = await erase.verify({ userId: ADA, input, response: approval });
  expect(evidence.credentialId).toBe(device.credentialId);
});

unitTest('an override reaches the signed bytes: another origin is refused', async () => {
  const { device, login } = await world();
  const phished = await device.get(await login.loginOptions(), { origin: 'https://evil.test' });
  await expect(login.login({ response: phished })).rejects.toBeUltimateError('X_PASSKEY_INVALID');
});

unitTest('an ES256 and an RS256 passkey are both real keys', async () => {
  for (const algorithm of ['ES256', 'RS256'] as const) {
    const { auth } = await world();
    const device = await softAuthenticator({ origin: ORIGIN, algorithm });
    const login = passkeyLogin(auth);
    const stored = await login.register({
      userId: ADA,
      response: await device.create(await login.registerOptions({ userId: ADA })),
    });
    expect(stored.algorithm).toBe(algorithm === 'ES256' ? -7 : -257);
  }
});
