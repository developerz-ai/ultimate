// The replay guard's SQL, against a real server. A claim is one statement, so the only thing that
// can answer "exactly one of twenty wins" is the primary key it conflicts on; the scripted twin
// (`mfa-replay-postgres.test.ts`) can prove the protocol and nothing about the statement.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file drops its
// table. `docker compose -f docker/docker-compose.test.yml up -d --wait` starts one.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { type Auth, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { installTotpReplay, resetTotpReplay } from './limiter-install';
import { memoryAuthAdapter } from './memory-adapter';
import { TOTP_STEP_SECONDS, totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import type { PostgresTotpReplayGuard } from './mfa-replay-postgres';
import { postgresTotpReplayGuard, SQL_TOTP_REPLAY_TABLE } from './mfa-replay-postgres';
import { saveTotpSecret } from './mfa-secret';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const START_MS = 1_700_000_000_000;
const AT = new Date(START_MS);
const STEP = totpStep(AT);
const STEP_MS = TOTP_STEP_SECONDS * 1000;

let sql: Bun.SQL;
let guard: PostgresTotpReplayGuard;

const executorOn = (client: Bun.SQL): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    (await client.unsafe(text, [...values])) as readonly R[],
});

const rowCount = async (): Promise<number> => {
  const rows = await sql.unsafe('select count(*)::int as n from x_totp_steps', []);
  return (rows as { readonly n: number }[])[0]?.n ?? -1;
};

beforeAll(async () => {
  if (url === undefined) return;
  sql = new Bun.SQL(url, { max: 8 });
  await sql.unsafe('drop table if exists x_totp_steps', []);
  // Twice: the boot applies it on every start, so it has to be idempotent.
  await sql.unsafe(SQL_TOTP_REPLAY_TABLE, []);
  await sql.unsafe(SQL_TOTP_REPLAY_TABLE, []);
  guard = postgresTotpReplayGuard({ executor: executorOn(sql) });
});

afterAll(async () => {
  if (url === undefined) return;
  await sql.unsafe('drop table if exists x_totp_steps', []);
  await sql.end();
});

beforeEach(async () => {
  if (url === undefined) return;
  await sql.unsafe('delete from x_totp_steps', []);
});

// At file scope, not inside `describeLive`: a reset behind the skip never runs on a skipped suite
// (`bun run skip-if-cleanup`), and clearing an install nobody made is a no-op.
afterEach(() => {
  resetTotpReplay();
});

describeLive('live · postgres · the shared TOTP replay guard', () => {
  test('twenty concurrent claims of one step: exactly one wins', async () => {
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => guard.claim('user-1', STEP, AT)),
    );
    expect(claims.filter((won) => won)).toHaveLength(1);
    expect(await rowCount()).toBe(1);
  });

  test('a second subject and a second step are unaffected', async () => {
    expect(await guard.claim('user-1', STEP, AT)).toBe(true);
    expect(await guard.claim('user-2', STEP, AT)).toBe(true);
    expect(await guard.claim('user-1', STEP + 1, AT)).toBe(true);
    expect(await guard.claim('user-1', STEP, AT)).toBe(false);
    expect(await rowCount()).toBe(3);
  });

  test('a second replica over the same table loses the claim', async () => {
    const other = postgresTotpReplayGuard({ executor: executorOn(sql) });
    expect(await guard.claim('user-1', STEP, AT)).toBe(true);
    expect(await other.claim('user-1', STEP, AT)).toBe(false);
  });

  test('the sweep takes steps no replica can offer again, and counts what went', async () => {
    // Inside the window `verifyTotp` accepts now, plus the slack for a replica running behind.
    await guard.claim('kept-current', STEP, AT);
    await guard.claim('kept-previous', STEP - 1, AT);
    await guard.claim('kept-lagging', STEP - 3, AT);
    // Past all of it.
    await guard.claim('gone', STEP - 4, AT);
    await guard.claim('gone-long-ago', STEP - 1_000, AT);

    expect(await guard.purgeExpired(START_MS)).toBe(2);
    expect(await rowCount()).toBe(3);
    // Nothing left to take: the second pass of the hour is a no-op, not an error.
    expect(await guard.purgeExpired(START_MS)).toBe(0);
    // The kept rows still refuse: a sweep that took them would have reopened those codes.
    expect(await guard.claim('kept-lagging', STEP - 3, AT)).toBe(false);
  });

  test('the sweep measures against the clock it was handed, never the server', async () => {
    await guard.claim('user-1', STEP, AT);
    // Years behind the server's `now()`, and the row is still live by this clock.
    expect(await guard.purgeExpired(START_MS)).toBe(0);
    expect(await guard.purgeExpired(START_MS + STEP_MS * 4)).toBe(1);
  });

  test('the sign-in itself: two replicas over one installed guard', async () => {
    // What a host boot does before any app module imports; neither `defineAuth` names a guard.
    installTotpReplay(() => postgresTotpReplayGuard({ executor: executorOn(sql) }));
    const clock = frozenClock(START_MS);
    const adapter = memoryAuthAdapter(clock);
    const pod = (): Auth =>
      defineAuth({ adapter, clock, password: { minLength: 12, params: FAST_PARAMS } });
    const podA = pod();
    const podB = pod();
    const user = await register(podA, { email: 'ada@corp.test', password: PASSWORD });
    await saveTotpSecret(podA, user.id, 'JBSWY3DPEHPK3PXP');
    const code = totpCode('JBSWY3DPEHPK3PXP', STEP);
    const challenge = async (auth: Auth): Promise<string> => {
      const error = await caught(() => login(auth, { email: 'ada@corp.test', password: PASSWORD }));
      const value = error?.meta?.['challenge'];
      return typeof value === 'string' ? value : expect.unreachable('no challenge in meta');
    };

    const first = await completeMfa(podA, await challenge(podA), code);
    expect(first.session.mfaSatisfied).toBe(true);
    const replay = await caught(async () => completeMfa(podB, await challenge(podB), code));
    expect(replay?.code).toBe('X_UNAUTHENTICATED');
  });
});
