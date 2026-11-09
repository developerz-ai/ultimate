// The write lane's choice: only an action an anonymous POST can reach, never one the app's
// `exercise.ts` turns off or runs as an actor, and a fresh draw per request with the override bound.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { defineExercise } from './define-exercise';
import type { DrillWriteCandidate } from './drill-writes';
import { DRILL_DRAW_SEED, drillWriteTargets } from './drill-writes';

const input = t.object({ email: t.email, message: t.string.min(1) });

const candidate = (over: Partial<DrillWriteCandidate>): DrillWriteCandidate => ({
  name: 'contactSales',
  method: 'POST',
  path: '/api/sales/contact',
  anonymous: true,
  input,
  ...over,
});

describe('drillWriteTargets', () => {
  test('an anonymous POST rides the lane; every other action is skipped with its reason', async () => {
    const writes = await drillWriteTargets({
      actions: [
        candidate({}),
        candidate({ name: 'publishPost', anonymous: false }),
        candidate({ name: 'removePost', method: 'DELETE' }),
        candidate({ name: 'pinned', path: '/api/posts/:id/pin' }),
        candidate({ name: 'endSession' }),
        candidate({ name: 'movePostStatus' }),
      ],
      overrides: defineExercise({
        endSession: { off: 'sets a cookie' },
        movePostStatus: { actor: userActor({ id: 'a', roles: ['author'] }) },
      }),
    });
    expect(writes.targets.map((target) => target.path)).toEqual(['/api/sales/contact']);
    expect(writes.skipped).toEqual([
      { name: 'publishPost', reason: 'its policy refuses an anonymous caller' },
      { name: 'removePost', reason: 'answers DELETE; the load posts' },
      { name: 'pinned', reason: 'its path takes a parameter the load cannot bind' },
      { name: 'endSession', reason: 'exercise.ts turns it off: sets a cookie' },
      { name: 'movePostStatus', reason: 'exercise.ts runs it as a signed-in actor' },
    ]);
  });

  test('each request draws its own input under the drill seed, valid for the schema', async () => {
    const runs: number[] = [];
    const writes = await drillWriteTargets({
      actions: [candidate({})],
      sampler: {
        arbitrary: (_schema, options) => {
          expect(options.seed).toBe(DRILL_DRAW_SEED);
          runs.push(options.run);
          return { email: `a${String(options.run)}@example.test`, message: 'm' };
        },
      },
    });
    const draw = writes.targets[0]?.draw ?? expect.unreachable();
    expect([draw(1), draw(2)]).toEqual([
      { email: 'a1@example.test', message: 'm' },
      { email: 'a2@example.test', message: 'm' },
    ]);
    expect(runs).toEqual([1, 2]);
    // The real sampler, as the exercise pass loads it: what it draws, the schema accepts.
    const real = await drillWriteTargets({ actions: [candidate({})] });
    const drawn = real.targets[0]?.draw?.(3);
    expect((await input['~standard'].validate(drawn)).issues).toBeUndefined();
  });

  test("an 'action:'-qualified entry is the drill's too, over the bare name", async () => {
    const writes = await drillWriteTargets({
      actions: [candidate({}), candidate({ name: 'endSession' })],
      overrides: defineExercise({
        contactSales: { actor: null, input: (drawn) => ({ ...drawn, message: 'bare' }) },
        'action:contactSales': { actor: null, input: (drawn) => ({ ...drawn, message: 'own' }) },
        'action:endSession': { off: 'sets a cookie' },
      }),
      sampler: { arbitrary: () => ({ email: 'a@example.test', message: 'drawn' }) },
    });
    expect(writes.targets[0]?.draw?.(1)).toEqual({ email: 'a@example.test', message: 'own' });
    expect(writes.skipped).toEqual([
      { name: 'endSession', reason: 'exercise.ts turns it off: sets a cookie' },
    ]);
  });

  test("an anonymous override's input binds into every draw", async () => {
    const writes = await drillWriteTargets({
      actions: [candidate({})],
      overrides: defineExercise({
        contactSales: { actor: null, input: (drawn) => ({ ...drawn, message: 'bound' }) },
      }),
      sampler: { arbitrary: () => ({ email: 'a@example.test', message: 'drawn' }) },
    });
    expect(writes.targets[0]?.draw?.(1)).toEqual({ email: 'a@example.test', message: 'bound' });
  });

  test('an async override input is left out: it is computed from a pass the load does not run', async () => {
    const writes = await drillWriteTargets({
      actions: [candidate({})],
      overrides: defineExercise({
        contactSales: { actor: null, input: async (drawn) => ({ ...drawn, message: 'signed' }) },
      }),
      sampler: { arbitrary: () => ({ email: 'a@example.test', message: 'drawn' }) },
    });
    expect(writes.targets).toEqual([]);
    expect(writes.skipped[0]?.reason).toContain('async input');
  });

  // A plain function returning a promise carries no `async` tag: drawn, its body was
  // `JSON.stringify(promise)` — `{}` — posted on every request. What it RETURNS is the test.
  test('an override input that returns a promise is left out, as an async one is', async () => {
    const writes = await drillWriteTargets({
      actions: [candidate({})],
      overrides: defineExercise({
        contactSales: {
          actor: null,
          input: (drawn) => Promise.resolve({ ...drawn, message: 'signed' }),
        },
      }),
      sampler: { arbitrary: () => ({ email: 'a@example.test', message: 'drawn' }) },
    });
    expect(writes.targets).toEqual([]);
    expect(writes.skipped).toEqual([
      {
        name: 'contactSales',
        reason: 'exercise.ts computes its input from the pass (an async input); a load has none',
      },
    ]);
  });
});
