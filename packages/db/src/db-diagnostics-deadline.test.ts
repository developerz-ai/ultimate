// Single responsibility: the client-side deadlines `dbDiagnostics` keeps for a driver that cannot
// interrupt a statement (PGlite applies `statement_timeout` and cannot fire it mid-scan): a section
// that never answers is reported unavailable, and past the whole-command deadline nothing is sent.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import type { DbClient } from './client';
import { DIAGNOSTICS_SECTION_DEADLINE_MS, dbDiagnostics } from './db-diagnostics';
import { recordingClient } from './fake';
import type { SqlFragment } from './sql';

/** Every statement containing `match` never settles; the rest answer as a recording client does. */
function hanging(match: string): DbClient & { readonly texts: readonly string[] } {
  const base = recordingClient();
  // Recorded, then never answered: the send happened, the reply never comes.
  const run = <T>(fragment: SqlFragment, answer: () => Promise<T>): Promise<T> => {
    const sent = answer();
    return fragment.text.includes(match) ? new Promise<T>(() => undefined) : sent;
  };
  return {
    get texts() {
      return base.texts;
    },
    query: (fragment) => run(fragment, () => base.query(fragment)),
    one: (fragment) => run(fragment, () => base.one(fragment)),
    execute: (fragment) => run(fragment, () => base.execute(fragment)),
  };
}

/** Fires armed deadlines on demand — all of them, or those armed for `ms`: no wall clock. */
function manualSchedule(): { readonly schedule: Scheduler; fire(ms?: number): void } {
  const armed = new Map<() => void, number>();
  return {
    schedule: (fn, ms) => {
      armed.set(fn, ms);
      return () => armed.delete(fn);
    },
    fire: (ms) => {
      for (const [fn, at] of [...armed]) {
        if (ms !== undefined && at !== ms) continue;
        armed.delete(fn);
        fn();
      }
    },
  };
}

/** Lets the pending sends reach their deadline before firing it. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

describe('dbDiagnostics deadlines', () => {
  test('a section that never answers is unavailable with a coded reason; the rest answer', async () => {
    const client = hanging('pg_blocking_pids');
    const clock = manualSchedule();
    const pending = dbDiagnostics({ client, schedule: clock.schedule });
    await settle();
    clock.fire(DIAGNOSTICS_SECTION_DEADLINE_MS);
    const report = await pending;
    expect(report.blockers).toMatchObject({ available: false, code: 'X_DB_STATEMENT_TIMEOUT' });
    if (report.blockers.available) return expect.unreachable('blockers timed out');
    expect(report.blockers.reason).toContain('no answer within');
    expect(report.activity.available).toBe(true);
    expect(report.deadTuples.available).toBe(true);
  });

  test('past the whole-command deadline, the sections not yet asked are not sent', async () => {
    const client = hanging('pg_blocking_pids');
    const clock = manualSchedule();
    const pending = dbDiagnostics({ client, schedule: clock.schedule });
    await settle();
    // The section deadline and the command deadline are both armed now; firing both ends the run.
    clock.fire();
    const report = await pending;
    for (const section of Object.values(report)) {
      expect(section).toMatchObject({ available: false, code: 'X_DB_STATEMENT_TIMEOUT' });
    }
    expect(client.texts.filter((text) => text.startsWith('DECLARE'))).toHaveLength(1);
  });

  test('a probe that never answers is X_DB_UNAVAILABLE, never a hang', async () => {
    const client = hanging('select 1');
    const clock = manualSchedule();
    const pending = dbDiagnostics({ client, schedule: clock.schedule });
    await settle();
    clock.fire(DIAGNOSTICS_SECTION_DEADLINE_MS);
    expect(await pending.catch((error: unknown) => error)).toMatchObject({
      code: 'X_DB_UNAVAILABLE',
    });
  });

  // A cold embedded database boots inside the probe — a WASM compile and an initdb, 12.6 s under
  // coverage in CI — so a caller that knows it is cold widens the probe's wait, not a section's.
  test('deadlineMs widens the probe: the section deadline no longer ends it, deadlineMs does', async () => {
    const client = hanging('select 1');
    const clock = manualSchedule();
    let settled = false;
    const pending = dbDiagnostics({ client, schedule: clock.schedule, deadlineMs: 30_000 }).finally(
      () => {
        settled = true;
      },
    );
    pending.catch(() => undefined);
    await settle();
    clock.fire(DIAGNOSTICS_SECTION_DEADLINE_MS);
    await settle();
    expect(settled).toBe(false);
    clock.fire(30_000);
    expect(await pending.catch((error: unknown) => error)).toMatchObject({
      code: 'X_DB_UNAVAILABLE',
    });
  });

  test('deadlineMs is the whole command: sections past it are not sent', async () => {
    const client = hanging('pg_blocking_pids');
    const clock = manualSchedule();
    const pending = dbDiagnostics({ client, schedule: clock.schedule, deadlineMs: 30_000 });
    await settle();
    clock.fire(30_000);
    clock.fire(DIAGNOSTICS_SECTION_DEADLINE_MS);
    const report = await pending;
    if (report.activity.available) return expect.unreachable('not sent past the deadline');
    expect(report.activity.reason).toContain('30000ms deadline');
  });

  test.each([0, -1, 1.5, Number.NaN])('deadlineMs %p is refused unsent', async (deadlineMs) => {
    const client = hanging('never');
    const error = await dbDiagnostics({ client, deadlineMs }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'X_INVARIANT' });
    expect(client.texts).toEqual([]);
  });
});
