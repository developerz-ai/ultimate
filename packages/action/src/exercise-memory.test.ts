// The exercise under `bun test` with no client: the app's store is memory, and every run's writes
// to it are undone — a handler that passes no `tx`, as a real one does, included.

import { afterAll, describe, expect, test } from 'bun:test';
import { EXERCISE_RUNS, isUltimateError } from '@ultimat3/core';
import { dbClientInstalled } from '@ultimat3/db';
import { clearRegistry, database, entity, testDriver, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { exerciseAction } from './exercise';
import { inRolledBackScope, rollbackAvailable } from './tx-scope';

afterAll(() => {
  clearRegistry();
});

const notes = entity('exercised_notes', {
  columns: { id: uuid().primaryKey(), title: text() },
});
const db = database({ notes }, { driver: testDriver() });
const Input = t.object({ title: t.string.min(1).max(40) });
const Output = t.object({ before: t.number });

const stored = async (): Promise<number> => (await db.notes.all()).length;

describe('every run rolls back — the memory store', () => {
  test('no client installed: the memory store is what the exercise rolls back', () => {
    expect(dbClientInstalled()).toBe(false);
    expect(rollbackAvailable()).toBe(true);
  });

  test('a row inserted by every run is gone after the exercise, and no run saw another', async () => {
    const seen: number[] = [];
    const inserting = action({
      input: Input,
      output: Output,
      policy: allow(),
      async handle({ input }) {
        const before = await stored();
        seen.push(before);
        await db.notes.insert({ id: crypto.randomUUID(), title: input.title });
        return { before };
      },
    }).named('insertingNote');
    const report = await exerciseAction(inserting, { actor: null });
    expect(report.reached).toBe(EXERCISE_RUNS);
    expect(seen).toEqual(Array.from({ length: EXERCISE_RUNS }, () => 0));
    expect(await stored()).toBe(0);
  });

  test('a handler that throws after its write is a defect, and the write is still undone', async () => {
    const breaking = action({
      input: Input,
      output: Output,
      policy: allow(),
      async handle({ input }) {
        await db.notes.insert({ id: crypto.randomUUID(), title: input.title });
        // The handler's foreign failure: input to the exercise, never this test's verdict.
        return Promise.reject(new TypeError('broke after the write'));
      },
    }).named('breakingNote');
    const failure = await exerciseAction(breaking, { actor: null }).catch(
      (error: unknown) => error,
    );
    expect(isUltimateError(failure) && failure.code).toBe('X_CONTRACT_DEFECT');
    expect(await stored()).toBe(0);
  });

  test('the scope hands back what the run settled to, answer or throw', async () => {
    const answered = await inRolledBackScope(async () => {
      await db.notes.insert({ id: crypto.randomUUID(), title: 'kept?' });
      return 'answered';
    });
    expect(answered).toEqual({ ok: true, value: 'answered' });
    const broke = new TypeError('broke');
    const thrown = await inRolledBackScope(async () => {
      await db.notes.insert({ id: crypto.randomUUID(), title: 'kept?' });
      throw broke;
    });
    expect(thrown).toEqual({ ok: false, error: broke });
    expect(await stored()).toBe(0);
  });
});
