// The one declaration, read by both runners: the value `defineExercise()` returns is what an
// action's and a query's `.contract({ exercise })` take, and each reads its own entry from it.

import { describe, expect, test } from 'bun:test';
import type { ExerciseDeclarations } from '@ultimat3/action';
import { action } from '@ultimat3/action';
import { EXERCISE_RUNS } from '@ultimat3/core';
import { can, definePermissions, testActor } from '@ultimat3/policy';
import type { QueryExerciseDeclarations } from '@ultimat3/query';
import { from, query } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineExercise } from './define-exercise';

definePermissions(['note:write', 'note:read']);
const ADA = testActor('ada', { permissions: ['note:write', 'note:read'] }).actor;
const Input = t.object({ title: t.string.min(1).max(40) });

describe('defineExercise() is the contract step’s declaration too', () => {
  const seen: string[] = [];
  const writeNote = action({
    input: Input,
    output: t.object({ ok: t.boolean }),
    policy: can('note:write'),
    handle: ({ ctx }) => {
      seen.push(`action:${ctx.actor.id}`);
      return { ok: true };
    },
  }).named('writeNote');
  const readNotes = query({
    input: Input,
    policy: can('note:read'),
    sql: (_input, ctx) => {
      seen.push(`query:${ctx.actor.id}`);
      return from<{ id: string }>('notes', []);
    },
  }).named('readNotes');
  const exercise = defineExercise({ writeNote: { actor: ADA }, readNotes: { actor: ADA } });

  test('its value is both packages’ declarations type, with no cast', () => {
    const forActions: ExerciseDeclarations = exercise;
    const forQueries: QueryExerciseDeclarations = exercise;
    expect(forActions.entries.get('writeNote')).toEqual({ actor: ADA });
    expect(forQueries.entries.get('readNotes')).toEqual({ actor: ADA });
  });

  test('an action and a query each run their own entry, as its actor', async () => {
    seen.length = 0;
    const [, , , fourth] = writeNote.contract({ exercise });
    await fourth?.run();
    const [read] = readNotes.contract({ exercise });
    await read?.run();
    expect(seen.filter((s) => s.startsWith('action:'))).toHaveLength(EXERCISE_RUNS);
    expect(new Set(seen)).toEqual(new Set([`action:${ADA.id}`, `query:${ADA.id}`]));
  });
});

describe('defineExercise(…, { actor }) names whose rows ARE the actors', () => {
  test('an entity alone: its key is the actor id', () => {
    const exercise = defineExercise({}, { actor: { $name: 'members' } });
    expect(exercise.actorEntity).toBe('members');
    expect(exercise.actorColumn).toBeUndefined();
  });

  test('{ entity, column }: that column holds the user, and the pass is told which', () => {
    const exercise = defineExercise(
      {},
      { actor: { entity: { $name: 'memberships' }, column: 'userId' } },
    );
    expect(exercise.actorEntity).toBe('memberships');
    expect(exercise.actorColumn).toBe('userId');
  });
});

describe('defineExercise({ name: { statements } }) moves one ceiling, with a reason', () => {
  const refusal = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  test('a whole max ≥ 1 and a stated why are kept on the entry', () => {
    const statements = { max: 140, why: 'one row per form line' };
    expect(defineExercise({ importRows: { statements } }).entries.get('importRows')).toEqual({
      statements,
    });
  });

  test('a blank why is X_CONTRACT_EXERCISE_UNDECLARED; a fractional max is refused', () => {
    expect(
      refusal(() => defineExercise({ a: { statements: { max: 5, why: ' ' } } })),
    ).toMatchObject({ code: 'X_CONTRACT_EXERCISE_UNDECLARED' });
    expect(
      refusal(() => defineExercise({ a: { statements: { max: 2.5, why: 'w' } } })),
    ).toMatchObject({ cause: expect.stringContaining('a.statements.max') });
    expect(
      refusal(() => defineExercise({ a: { statements: { max: 0, why: 'w' } } })),
    ).toBeDefined();
  });
});
