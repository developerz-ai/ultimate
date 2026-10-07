// The sealed second factor against a real server: the one-shot seal over rows a previous release
// left in the clear, and a recovery code redeemed from several CONNECTIONS at once — PGlite is one
// connection, so only a pool can show two sessions racing for one row.
//
// Skips unless `TEST_DATABASE_URL` is set. It writes only rows it created, in `x_users`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, isSealed } from '@ultimat3/core';
import { postgresClient, raw, sql } from '@ultimat3/db';
import { defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { type PostgresAuthAdapter, postgresAuthAdapter } from './builtin-adapter';
import { generateRecoveryCodes, totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { countUnsealedMfaSecrets, saveTotpSecret, sealMfaSecrets } from './mfa-secret';
import { AUTH_TABLES } from './tables';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const SECRET = 'JBSWY3DPEHPK3PXP';
const DOMAIN = 'mfa-secret-live.test';
const clock = frozenClock(1_700_000_000_000);

let client: ReturnType<typeof postgresClient>;
let adapter: PostgresAuthAdapter;

const wipe = async (): Promise<void> => {
  await client.execute(sql`delete from x_users where email like ${`%@${DOMAIN}`}`);
};

beforeAll(async () => {
  if (url === undefined) return;
  client = postgresClient({ url, applicationName: 'auth-mfa-secret-live' });
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
  adapter = postgresAuthAdapter(client, clock);
});

afterAll(async () => {
  if (url === undefined) return;
  await wipe();
  await client.close();
});

beforeEach(async () => {
  if (url === undefined) return;
  await wipe();
});

const authOver = () =>
  defineAuth({
    adapter,
    clock,
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 50, orgMaxAttempts: 10_000 },
  });

const challengeFor = async (auth: ReturnType<typeof authOver>, email: string): Promise<string> => {
  const error = await caught(() => login(auth, { email, password: PASSWORD }));
  return String(error?.meta?.['challenge']);
};

const mine = async (): Promise<readonly string[]> => {
  const rows = await client.query<{ mfa_secret: string }>(
    sql`select mfa_secret from x_users where email like ${`%@${DOMAIN}`} and mfa_secret is not null order by email`,
  );
  return rows.map((row) => row.mfa_secret);
};

describeLive('live · postgres · the second factor at rest', () => {
  test('a row left in the clear is refused, sealed by the one-shot, and then signs in', async () => {
    const auth = authOver();
    const email = `legacy@${DOMAIN}`;
    const user = await register(auth, { email, password: PASSWORD });
    // What a release before sealing wrote: the base32 seed itself.
    await adapter.updateUser(user.id, { mfaSecret: SECRET });
    expect(await countUnsealedMfaSecrets(auth)).toBeGreaterThanOrEqual(1);

    const code = (): string => totpCode(SECRET, totpStep(clock.now()));
    const refused = await caught(async () =>
      completeMfa(auth, await challengeFor(auth, email), code()),
    );
    expect(refused?.code).toBe('X_MFA_SECRET_UNSEALED');

    const first = await sealMfaSecrets(auth);
    expect(first.sealed).toBeGreaterThanOrEqual(1);
    const sealed = await mine();
    expect(sealed).toHaveLength(1);
    expect(sealed.every((value) => isSealed(value))).toBe(true);
    expect(sealed.join()).not.toContain(SECRET);

    // Idempotent: nothing left to seal, and what was sealed is byte-identical.
    expect((await sealMfaSecrets(auth)).sealed).toBe(0);
    expect(await mine()).toEqual(sealed);
    expect(await countUnsealedMfaSecrets(auth)).toBe(0);

    const finished = await completeMfa(auth, await challengeFor(auth, email), code());
    expect(finished.session.mfaSatisfied).toBe(true);
  });

  test('enrolment writes sealed, so a fresh row needs no one-shot', async () => {
    const auth = authOver();
    const user = await register(auth, { email: `fresh@${DOMAIN}`, password: PASSWORD });
    await saveTotpSecret(auth, user.id, SECRET);
    expect((await mine()).every((value) => isSealed(value))).toBe(true);
    expect(await countUnsealedMfaSecrets(auth)).toBe(0);
  });

  test('one recovery code presented on eight connections finishes exactly one sign-in', async () => {
    const auth = authOver();
    const email = `recover@${DOMAIN}`;
    const user = await register(auth, { email, password: PASSWORD });
    await saveTotpSecret(auth, user.id, SECRET);
    const set = generateRecoveryCodes(2);
    await adapter.updateUser(user.id, { recoveryCodeHashes: set.hashes });

    const challenge = await challengeFor(auth, email);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => completeMfa(auth, challenge, set.codes[0] ?? '')),
    );
    expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect((await adapter.findUserById(user.id))?.recoveryCodeHashes).toHaveLength(1);
    expect(await adapter.listSessions(user.id)).toHaveLength(1);
  });
});
