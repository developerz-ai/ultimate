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
import { disableUser, RECLAIM_LEASE_MS, reclaimAccount } from './revocation';

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

  test('a sweep that fails leaves the account shut and unverified; past the lease a rerun finishes and reopens it', async () => {
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
    // Inside the lease the failed claim still excludes another reclaim, which writes nothing.
    const early = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(early?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById(r.userId))?.disabledAt).toEqual(stuck?.disabledAt ?? null);
    w.clock.advance(RECLAIM_LEASE_MS);
    const result = await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    expect(result.passkeysDeleted).toBe(1);
    expect(result.user.emailVerifiedAt).toEqual(w.clock.now());
    expect(result.user.disabledAt).toBeNull();
    expect((await redeem(w.auth, await mailed(w))).session.userId).toBe(r.userId);
  });

  test("an operator's disabled account is refused and left exactly as it was", async () => {
    const w = world();
    const r = await registrant(w);
    const disabled = await disableUser(w.auth, r.userId, 'offboarded');

    const refused = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(refused?.code).toBe('X_UNAUTHENTICATED');
    expect(refused?.fix).toContain('enableUser');
    expect(await w.adapter.findUserById(r.userId)).toEqual(disabled.user);
    expect(await w.adapter.listPasskeys(r.userId)).toHaveLength(1);
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

  test('a second reclaim while the first sweeps is refused, and never sweeps what the first hands over', async () => {
    const w = world();
    const r = await registrant(w);
    const list = w.adapter.listPasskeys.bind(w.adapter);
    let second: string | undefined;
    // The first is mid-sweep; the second (another replica, a second reset callback) arrives now.
    spyOn(w.adapter, 'listPasskeys').mockImplementationOnce(async (userId) => {
      second = (await caught(() => reclaimAccount(w.auth, userId, 'second callback')))?.code;
      return await list(userId);
    });

    const first = await reclaimAccount(w.auth, r.userId, 'address proven by reset');
    expect(second).toBe('X_UNAUTHENTICATED');
    expect(first.passkeysDeleted).toBe(1);
    expect(first.user.disabledAt).toBeNull();
    const owner = await redeem(w.auth, await mailed(w));
    expect((await authenticate(w.auth, owner.token)).id).toBe(r.userId);
  });

  test('two reclaims started together: exactly one claims the account', async () => {
    const w = world();
    const r = await registrant(w);
    const outcomes = await Promise.all(
      [1, 2, 3].map(async (n) =>
        reclaimAccount(w.auth, r.userId, `callback ${n}`).then(
          () => 'reclaimed',
          (error: unknown) => (isUltimateError(error) ? error.code : 'thrown'),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'reclaimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'X_UNAUTHENTICATED')).toHaveLength(2);
  });

  test('a reclaim whose claim is taken over past the lease stops before its next sweep', async () => {
    const w = world();
    const r = await registrant(w);
    const revokeKeys = w.adapter.listApiKeys.bind(w.adapter);
    let takeover: string | undefined;
    // The first stalls past the lease after revoking sessions; a second takes the account over.
    spyOn(w.adapter, 'listApiKeys').mockImplementationOnce(async (userId) => {
      w.clock.advance(RECLAIM_LEASE_MS);
      takeover = (await reclaimAccount(w.auth, userId, 'takeover')).user.id;
      return await revokeKeys(userId);
    });
    const stalled = await caught(() => reclaimAccount(w.auth, r.userId, 'address proven by reset'));
    expect(takeover).toBe(r.userId);
    expect(stalled?.code).toBe('X_UNAUTHENTICATED');
    expect((await w.adapter.findUserById(r.userId))?.disabledAt).toBeNull();
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
