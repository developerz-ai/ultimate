// The guard's protocol, over a scripted executor: what a row back means, what no row back means,
// and that a failing store is not read as either. The statement itself is the live twin's claim.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { TOTP_DRIFT_STEPS, TOTP_STEP_SECONDS, totpStep } from './mfa';
import { postgresTotpReplayGuard, SQL_TOTP_CLAIM, SQL_TOTP_PURGE } from './mfa-replay-postgres';
import { SQL_TOTP_REPLAY_TABLE } from './tables';

const AT = new Date(1_700_000_000_000);

const scripted = (
  rows: readonly unknown[],
): { readonly executor: PgExecutor; readonly seen: (readonly [string, readonly unknown[]])[] } => {
  const seen: (readonly [string, readonly unknown[]])[] = [];
  return {
    seen,
    executor: {
      query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
        seen.push([text, values]);
        return rows as readonly R[];
      },
    },
  };
};

describe('postgresTotpReplayGuard', () => {
  test('a row back is the first use, bound to the subject, step and instant', async () => {
    const { executor, seen } = scripted([{ claimed: 1 }]);
    expect(await postgresTotpReplayGuard({ executor }).claim('user-1', 42, AT)).toBe(true);
    expect(seen).toEqual([[SQL_TOTP_CLAIM, ['user-1', 42, AT.toISOString()]]]);
  });

  test('no row back is a replay: the conflict wrote nothing', async () => {
    const { executor } = scripted([]);
    expect(await postgresTotpReplayGuard({ executor }).claim('user-1', 42, AT)).toBe(false);
  });

  test('a store that fails rejects, and is never read as an answer', async () => {
    const down = new TypeError('connection refused');
    const executor: PgExecutor = { query: () => Promise.reject(down) };
    const thrown = await postgresTotpReplayGuard({ executor })
      .claim('user-1', 42, AT)
      .catch((error: unknown) => error);
    expect(thrown).toBe(down);
  });

  test('the sweep floor is below the drift window and the slack for a lagging replica', async () => {
    const { executor, seen } = scripted([{ removed: '3' }]);
    // A bigint count arrives as a string from every Postgres client.
    expect(await postgresTotpReplayGuard({ executor }).purgeExpired(AT.getTime())).toBe(3);
    const floor = seen[0]?.[1][0];
    expect(seen[0]?.[0]).toBe(SQL_TOTP_PURGE);
    expect(floor).toBe(totpStep(AT) - TOTP_DRIFT_STEPS - 2);
    // A row at the edge of what a replica one minute behind still offers is above that floor.
    const lagging = new Date(AT.getTime() - 2 * TOTP_STEP_SECONDS * 1000);
    expect(totpStep(lagging) - TOTP_DRIFT_STEPS).toBeGreaterThanOrEqual(Number(floor));
  });

  test('every statement in the DDL survives the one-at-a-time applier', () => {
    // `framework-schema.ts` splits on `;`, so one inside a literal would break the boot.
    const statements = SQL_TOTP_REPLAY_TABLE.split(';').filter((text) => text.trim().length > 0);
    expect(statements[0]).toContain('create table if not exists x_totp_steps');
    expect(statements[0]).toContain('primary key (subject, step)');
  });
});
