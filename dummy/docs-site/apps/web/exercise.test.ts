// The overrides load, every primitive they turn off says why, and the floor that judges the pass
// is the one `x new` writes: every proof must ask, and no call over the default statement ceiling.
import { expect, unitTest } from '@ultimat3/testing';
import { exercise } from './exercise';

unitTest('apps/web/exercise.ts loads, and every off entry names its reason', () => {
  for (const [name, entry] of exercise.entries) {
    if ('off' in entry) {
      expect({ name, blank: entry.off.trim() === '' }).toEqual({ name, blank: false });
    }
  }
  expect(exercise.entries).toBeInstanceOf(Map);
});

unitTest('x.verify.json floors the pass: no unproven proof, 100 statements', async () => {
  const config: unknown = await Bun.file(new URL('../../x.verify.json', import.meta.url)).json();
  expect(config).toMatchObject({ exercise: { unprovenMax: 0, statementsMax: 100 } });
});

// The readiness probe answers its role and reads nothing: a pass over it proves nothing, and the
// gate's `X_EXERCISE_EMPTY_REACH` line says so unless the override does.
unitTest('health is off the pass, with its reason', () => {
  const entry = exercise.entries.get('health');
  expect(entry !== undefined && 'off' in entry).toBe(true);
});
