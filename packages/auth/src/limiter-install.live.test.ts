// The seam end to end, against a real server: two pods that share nothing but a database, each
// with its own `defineAuth` and its own adapter, and a lockout one of them established refusing
// the other. This is the claim `postgresAuthLimiter` could not make until there was somewhere to
// install it from — the store was shipped and tested, and no host could reach it.
//
// The scripted-executor twin cannot prove this: what is under test is the WIRING (which limiter
// `defineAuth` picks up, and which policy the factory is handed), and the two pods only differ if
// the rows are really in one table.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file writes to the
// framework's own tables. Locally:
//
//   docker run -d --name x-auth -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/auth/src/limiter-install.live.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { Auth } from './auth';
import { defineAuth, login, register } from './auth';
import { configureAuthLimiters, purgeAuthLimits, resetAuthLimiters } from './limiter-install';
import { MemoryAdapter } from './memory-adapter';
import type { AuthRateLimitPolicy } from './rate-limit';
import type { PgExecutor } from './rate-limit-postgres';
import { postgresAuthLimiter, SQL_AUTH_LIMIT_TABLES } from './rate-limit-postgres';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const START_MS = 1_700_000_000_000;
const clock = frozenClock(START_MS);

/**
 * The app's declaration, and it says NOTHING about scope — so it resolves to `'process'`, which is
 * the state every scaffolded app is in. That is the point: the fleet-wide lockout has to arrive
 * without the app remembering to ask for it, because `x new` scaffolds `replicas: 2` and the
 * shipped chart runs three.
 */
const rateLimit: Partial<AuthRateLimitPolicy> = {
  maxAttempts: 3,
  windowMs: 60_000,
  lockoutMs: 300_000,
};

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * Deliberately below the shipped OWASP floor. This suite runs six argon2 hashes and none of them
 * is the subject; the KDF parameters are `password.test.ts`'s claim, not this file's.
 */
const params = { algorithm: 'argon2id', memoryCost: 8, timeCost: 1 } as const;

let sql: Bun.SQL;

const executorOn = (client: Bun.SQL): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    (await client.unsafe(text, [...values])) as readonly R[],
});

/** One replica: its own adapter, its own `defineAuth`, and NOTHING said about a limiter. */
async function pod(): Promise<Auth> {
  const auth = defineAuth({
    adapter: new MemoryAdapter(),
    clock,
    rateLimit,
    password: { params },
  });
  await register(auth, { email: EMAIL, password: PASSWORD });
  return auth;
}

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 4 });
  await sql.unsafe(SQL_AUTH_LIMIT_TABLES, []);
});

afterAll(async () => {
  if (url === undefined) return;
  resetAuthLimiters();
  await sql.unsafe('delete from x_auth_failures', []);
  await sql.unsafe('delete from x_auth_lockouts', []);
  await sql.end();
});

beforeEach(async () => {
  if (url === undefined) return;
  clock.set(START_MS);
  await sql.unsafe('delete from x_auth_failures', []);
  await sql.unsafe('delete from x_auth_lockouts', []);
  // What a host boot does once, before it imports a single app module.
  configureAuthLimiters((policy) =>
    postgresAuthLimiter({ executor: executorOn(sql), clock, policy }),
  );
});

describeLive('live · postgres · the installed auth limiter', () => {
  test('an app that declares nothing gets the shared limiter, for BOTH buckets', async () => {
    const auth = await pod();
    // The app declared `'process'` by omission and got `'shared'` — an upgrade, which
    // `assertAuthLimiterPolicy` permits; the refusal runs the other way round.
    expect(auth.rateLimit.scope).toBe('process');
    expect(auth.limiter.policy.scope).toBe('shared');
    // The tenant bucket too — `x new` scaffolds two replicas, and a per-process org cap under a
    // shared account cap is the half nobody notices is missing.
    expect(auth.orgLimiter.policy.scope).toBe('shared');
    expect(auth.limiter.policy.maxAttempts).toBe(3);
    // `orgMaxAttempts`, which this app left at the framework default rather than deriving it
    // from its own `maxAttempts` — the tenant bucket is a noisy-neighbour cap, not a lockout.
    expect(auth.orgLimiter.policy.maxAttempts).toBe(100);
  });

  test('a lockout one pod established refuses the CORRECT password on another', async () => {
    const podA = await pod();
    const podB = await pod();

    for (let i = 0; i < 3; i += 1) {
      expect(await codeOf(login(podA, { email: EMAIL, password: 'wrong-password-here' }))).toBe(
        'X_UNAUTHENTICATED',
      );
    }

    // Pod B counted zero failures and holds the right password. Before the seam existed it issued
    // a session here — `maxAttempts × replicas` guesses per account, which is the whole defect.
    expect(await codeOf(login(podB, { email: EMAIL, password: PASSWORD }))).toBe(
      'X_ACCOUNT_LOCKED',
    );
  });

  test('purgeAuthLimits clears what the lockout left behind, once it is dead', async () => {
    const podA = await pod();
    for (let i = 0; i < 3; i += 1) {
      await login(podA, { email: EMAIL, password: 'wrong-password-here' }).catch(() => undefined);
    }
    // Nothing is expired yet, so a sweep that reads the SERVER's clock instead of the pod's would
    // delete a live lockout here and hand the account straight back.
    expect(await purgeAuthLimits()).toBe(0);

    clock.advance(300_001);
    // Three failures plus one lockout row.
    expect(await purgeAuthLimits()).toBe(4);
    expect(await codeOf(login(podA, { email: EMAIL, password: PASSWORD }))).toBe('did-not-throw');
  });

  test('a pod that DOES declare scope: shared now boots, which it could not before', async () => {
    const auth = defineAuth({
      adapter: new MemoryAdapter(),
      clock,
      rateLimit: { ...rateLimit, scope: 'shared' },
      password: { params },
    });
    // Until the seam existed this threw `X_AUTH_LIMITER_NOT_SHARED`: the declaration was
    // satisfiable only by an app that built `postgresAuthLimiter` itself, and nothing scaffolded
    // one. The store shipped with no reachable install point.
    expect(auth.limiter.policy.scope).toBe('shared');
  });

  test('purgeAuthLimits answers 0 once the host has released its limiters', async () => {
    await pod();
    resetAuthLimiters();
    expect(await purgeAuthLimits()).toBe(0);
  });
});
