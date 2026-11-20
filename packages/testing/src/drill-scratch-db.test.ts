// The scratch database's drop, against a scripted admin connection: a logical slot a role's
// walsender still holds is waited for, then its holder terminated, then the database dropped — in
// that order, each wait bounded — and a holder that never leaves is a coded error, never a raw one.

import { describe, expect, test } from 'bun:test';
import { NotImplementedError } from '@ultimat3/core';
import type { ScratchAdminSql } from './drill-scratch-db';
import { dropScratchDatabase, SCRATCH_SLOT_POLLS } from './drill-scratch-db';

const NAME = 'x_drill_0123456789abcdef';
const ADMIN = 'postgres://ultimate:secret@127.0.0.1:5440/postgres?sslmode=disable';
const HOLDER = { slot_name: 'x_replicator', active_pid: 4242 };

type Step = 'poll' | 'terminate' | 'drop';

/** Answers each poll from `held` (true: the slot is still active), recording what ran in order. */
const scripted = (held: (poll: number) => boolean, dropFails = false) => {
  const steps: Step[] = [];
  const params: unknown[][] = [];
  let polls = 0;
  const sql: ScratchAdminSql = {
    async query(statement, values = []) {
      params.push([...values]);
      if (statement.startsWith('DROP DATABASE')) {
        steps.push('drop');
        if (dropFails) {
          throw new NotImplementedError({
            cause: 'database is being accessed by other users',
            fix: 'x drill --list --json',
          });
        }
        return [];
      }
      if (statement.includes('pg_terminate_backend')) {
        steps.push('terminate');
        return [{ pg_terminate_backend: true }];
      }
      steps.push('poll');
      polls += 1;
      return held(polls) ? [HOLDER] : [];
    },
    close: async () => undefined,
  };
  return { sql, steps, params };
};

const repeat = (step: Step, count: number): Step[] => Array.from({ length: count }, () => step);

describe('dropScratchDatabase', () => {
  test('no active slot: one poll, then the drop, and nobody is terminated', async () => {
    const { sql, steps, params } = scripted(() => false);
    await dropScratchDatabase(sql, NAME, ADMIN);
    expect(steps).toEqual(['poll', 'drop']);
    expect(params[0]).toEqual([NAME]);
  });

  test('a walsender that lets go inside the bound is waited for, not terminated', async () => {
    const { sql, steps } = scripted((poll) => poll < 3);
    await dropScratchDatabase(sql, NAME, ADMIN);
    expect(steps).toEqual([...repeat('poll', 3), 'drop']);
  });

  test('a holder past the bound is terminated, polled again, then the database dropped', async () => {
    const { sql, steps } = scripted((poll) => poll <= SCRATCH_SLOT_POLLS + 1);
    await dropScratchDatabase(sql, NAME, ADMIN);
    expect(SCRATCH_SLOT_POLLS).toBe(100);
    expect(steps).toEqual([
      ...repeat('poll', SCRATCH_SLOT_POLLS),
      'terminate',
      'poll',
      'poll',
      'drop',
    ]);
  });

  test('a holder that never leaves is a coded error naming it, and no drop is tried', async () => {
    const { sql, steps } = scripted(() => true);
    const error = await dropScratchDatabase(sql, NAME, ADMIN).catch((thrown: unknown) => thrown);
    expect(steps).toEqual([
      ...repeat('poll', SCRATCH_SLOT_POLLS),
      'terminate',
      ...repeat('poll', SCRATCH_SLOT_POLLS),
    ]);
    expect(error).toBeUltimateError('X_DRILL_TEARDOWN_FAILED');
    const cause = String(Reflect.get(error as object, 'cause'));
    expect(cause).toContain(NAME);
    expect(cause).toContain('x_replicator');
    expect(cause).toContain('4242');
    const fix = String(Reflect.get(error as object, 'fix'));
    expect(fix).toBe(
      'psql -h 127.0.0.1 -p 5440 -U ultimate -d postgres' +
        ` -c "select pg_terminate_backend(active_pid) from pg_replication_slots where database = '${NAME}'"` +
        ` -c 'select pg_sleep(1)' -c 'DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)'`,
    );
    expect(fix).not.toContain('secret');
  });

  test('a drop the server refuses is the same coded error, carrying what it said', async () => {
    const { sql, steps } = scripted(() => false, true);
    const error = await dropScratchDatabase(sql, NAME, ADMIN).catch((thrown: unknown) => thrown);
    expect(steps).toEqual(['poll', 'drop']);
    expect(error).toBeUltimateError('X_DRILL_TEARDOWN_FAILED');
    const cause = String(Reflect.get(error as object, 'cause'));
    expect(cause).toContain(NAME);
    expect(cause).toContain('being accessed by other users');
  });

  test('a name that is not a drill scratch database is refused before any statement', async () => {
    const { sql, steps } = scripted(() => false);
    const error = await dropScratchDatabase(sql, 'postgres"; drop', ADMIN).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeUltimateError('X_DRILL_TEARDOWN_FAILED');
    expect(steps).toEqual([]);
  });
});
