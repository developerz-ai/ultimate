// What the exercise room says a call read: every entity its statements were attributed to, and
// `null` once one statement carried no attribution — the tenant proof's `global` verdict rests on
// it, so hand-written SQL must never pass for a global read. A neighbour's statement is not the call's.

import { describe, expect, test } from 'bun:test';
import { instrument } from '@ultimat3/core';
import type { ExerciseRoom, Observed } from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { testName } from './test-types';

const emit = (entity: string | undefined): void =>
  instrument('db.statement', {
    text: 'select 1',
    values: [],
    durationMs: 0,
    rows: 0,
    ...(entity === undefined ? {} : { attribution: { entity, op: 'findMany' } }),
  });

const observed = async (room: ExerciseRoom, fn: () => Promise<void>): Promise<Observed> => {
  const seen = await room.observe('planCatalog', fn);
  if ('error' in seen) return expect.unreachable('the observed call answered');
  return seen.observed;
};

describe(testName('unit', 'openExerciseRoom: what a call read'), () => {
  test('each attributed entity once, first seen first', async () => {
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      emit('plans');
      emit('prices');
      emit('plans');
    });
    expect(seen.reads).toEqual(['plans', 'prices']);
  });

  test('one unattributed statement makes the read unknown', async () => {
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      emit('plans');
      emit(undefined);
    });
    expect(seen.reads).toBeNull();
  });

  test('the next call starts clean, and a statement outside it is not its read', async () => {
    await using room = await openExerciseRoom();
    await observed(room, async () => emit(undefined));
    emit('members');
    expect((await observed(room, async () => emit('plans'))).reads).toEqual(['plans']);
  });
});
