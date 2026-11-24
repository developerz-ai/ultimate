// `reclaimAccount`: an unverified account handed to the owner of its inbox. The failure cases
// first: swept while it still opened, the registrant's live session could enrol a passkey after
// the passkeys were listed; stamped verified before the sweep, a sweep that then failed left the
// account verified with the registrant still signed in.

import { describe, expect, spyOn, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { issueApiKey, verifyApiKey } from './api-keys';
import { authenticate, login, register } from './auth';
import { caught, PASSWORD } from './auth-fixture';
import { authWriteFailed } from './errors';
import { EMAIL, mailed, redeem, SECRET, type World, world } from './link-login-fixture';
import { saveTotpSecret } from './mfa-secret';
import { disableUser, reclaimAccount } from './revocation';

/** The pre-registration: signed in, with a second factor, an API key and a passkey. */
const registrant = async (w: World) => {
  const user = await register(w.auth, { email: EMAIL, password: PASSWORD });
  const signedIn = await login(w.auth, { email: EMAIL, password: PASSWORD });
  await saveTotpSecret(w.auth, user.id, SECRET);
  const key = issueApiKey({ env: 'prod', scopes: [], userId: user.id, clock: w.clock });
  await w.adapter.putApiKey(key.record);
  await w.adapter.putPasskey({
    id: 'registrant-passkey',
    userId: user.id,
    publicKey: 'cose-key',
    algorithm: -7,
    signCount: 0,
    transports: [],
    createdAt: w.clock.now(),
    lastUsedAt: null,
  });
  return { userId: user.id, session: signedIn.token, apiKey: key.plaintext };
};

describe('reclaimAccount', () => {
  test('the account is shut for the whole sweep, so the registrant can neither act nor sign in', async () => {
    const w = world();
    const r = await registrant(w);
    const seen: { session?: string; password?: string; verified?: Date | null } = {};
    const list = w.adapter.listPasskeys.bind(w.adapter);
    // The moment the race lived in: passkeys about to be listed, the registrant's session up to
    // now able to enrol one. Every door is asked here, mid-sweep.
    spyOn(w.adapter, 'listPasskeys').mockImplementation(async (userId) => {
      seen.session = (await caught(() => authenticate(w.auth, r.session)))?.code ?? 'admitted';
      seen.password =
        (await caught(() => login(w.auth, { email: EMAIL, password: PASSWORD })))?.code ??
        'signed in';
      seen.verified = (await w.adapter.findUserById(userId))?.emailVerifiedAt ?? null;
      return await list(userId);
    });

    const result = await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    expect(seen).toEqual({
      session: 'X_UNAUTHENTICATED',
      password: 'X_UNAUTHENTICATED',
      verified: null,
    });
    expect(result.sessionsRevoked).toBe(1);
    expect(result.apiKeysRevoked).toBe(1);
    expect(result.passkeysDeleted).toBe(1);
    expect(result.user.disabledAt).toBeNull();
    expect(result.user.emailVerifiedAt).toEqual(w.clock.now());
    expect(result.user.passwordHash).toBeNull();
    expect(result.user.mfaSecret).toBeNull();
    expect(await w.adapter.listPasskeys(r.userId)).toEqual([]);
    expect((await caught(() => verifyApiKey(w.adapter, r.apiKey, w.clock)))?.code).toBe(
      'X_API_KEY_INVALID',
    );
    expect((await redeem(w.auth, await mailed(w))).session.mfaSatisfied).toBe(true);
  });

  test('a sweep that fails leaves the account shut and unverified, and a rerun finishes and reopens it', async () => {
    const w = world();
    const r = await registrant(w);
    const failing = spyOn(w.adapter, 'deletePasskey').mockImplementation(async () => {
      throw authWriteFailed('deletePasskey', 'x_passkeys');
    });

    const failed = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(failed?.code).toBe('X_AUTH_WRITE_FAILED');
    const stuck = await w.adapter.findUserById(r.userId);
    expect(stuck?.emailVerifiedAt).toBeNull();
    expect(stuck?.disabledAt).not.toBeNull();
    expect(stuck?.passwordHash).toBeNull();
    expect((await caught(() => authenticate(w.auth, r.session)))?.code).toBe('X_UNAUTHENTICATED');
    expect((await caught(async () => redeem(w.auth, await mailed(w))))?.code).toBe(
      'X_UNAUTHENTICATED',
    );

    failing.mockRestore();
    const result = await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    expect(result.passkeysDeleted).toBe(1);
    expect(result.user.emailVerifiedAt).toEqual(w.clock.now());
    // The shut state is the reclaim's own, never a clock's instant, so the rerun knows it as its
    // own and lifts it.
    expect(result.user.disabledAt).toBeNull();
    expect((await redeem(w.auth, await mailed(w))).session.userId).toBe(r.userId);
  });

  test("an operator's disable outlives a reclaim: a reset link never lifts it", async () => {
    const w = world();
    const r = await registrant(w);
    const disabled = await disableUser(w.auth, r.userId, 'offboarded');

    const result = await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    expect(result.user.disabledAt).toEqual(disabled.user.disabledAt);
    expect(result.user.emailVerifiedAt).toEqual(w.clock.now());
    expect(result.passkeysDeleted).toBe(1);
    expect((await caught(async () => redeem(w.auth, await mailed(w))))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
  });

  test('an id no account holds is X_AUTH_WRITE_FAILED before any write', async () => {
    const w = world();
    const writes = spyOn(w.adapter, 'updateUserWhere');
    const error = await caught(() => reclaimAccount(w.auth, 'nobody', 'address proven by reset'));
    expect(error?.code).toBe('X_AUTH_WRITE_FAILED');
    expect(error?.meta?.['operation']).toBe('findUserById');
    expect(writes).not.toHaveBeenCalled();
  });

  test('an operator who disables the account mid-reclaim wins: it stays disabled and unverified', async () => {
    const w = world();
    const r = await registrant(w);
    const list = w.adapter.listPasskeys.bind(w.adapter);
    spyOn(w.adapter, 'listPasskeys').mockImplementation(async (userId) => {
      await disableUser(w.auth, userId, 'offboarded');
      return await list(userId);
    });

    const error = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    const after = await w.adapter.findUserById(r.userId);
    expect(after?.disabledAt).toEqual(w.clock.now());
    expect(after?.emailVerifiedAt).toBeNull();
    expect((await caught(async () => redeem(w.auth, await mailed(w))))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
  });

  test("a reset that arrives after another reclaimed the account touches nothing of the new owner's", async () => {
    const w = world();
    const r = await registrant(w);
    await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    await w.adapter.updateUser(r.userId, { passwordHash: 'owner-hash' });
    const owner = await redeem(w.auth, await mailed(w));

    const late = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(late?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById(r.userId))?.passwordHash).toBe('owner-hash');
    expect((await authenticate(w.auth, owner.token)).id).toBe(r.userId);
  });

  test('a reset whose read predates another reclaim finishing is refused by the shutting write', async () => {
    const w = world();
    const r = await registrant(w);
    const find = w.adapter.findUserById.bind(w.adapter);
    // The late callback reads the account unverified; the first one verifies it before the late
    // one's first write lands.
    spyOn(w.adapter, 'findUserById').mockImplementationOnce(async (id) => {
      const stale = await find(id);
      await w.adapter.updateUser(id, {
        emailVerifiedAt: w.clock.now(),
        passwordHash: 'owner-hash',
      });
      return stale;
    });

    const late = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(late?.code).toBe('X_UNAUTHENTICATED');
    const after = await w.adapter.findUserById(r.userId);
    expect(after?.passwordHash).toBe('owner-hash');
    expect(after?.disabledAt).toBeNull();
    expect(await w.adapter.listPasskeys(r.userId)).toHaveLength(1);
  });

  test('an adapter without updateUserWhere is refused before anything is written', async () => {
    const w = world();
    const r = await registrant(w);
    const bare = new Proxy(w.adapter, {
      get: (target, key) => {
        if (key === 'updateUserWhere') return undefined;
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let thrown: unknown;
    try {
      await reclaimAccount({ ...w.auth, adapter: bare }, r.userId, 'address proven by reset');
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : 'reclaimed').toBe('X_CONFIG_INVALID');
    expect((await w.adapter.findUserById(r.userId))?.disabledAt).toBeNull();
  });
});
