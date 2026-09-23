// The actor a route is rendered AS when the render exists only to be weighed. The framework's
// default holds every permission and carries no app facts; an app whose pages read facts declares
// its own, from `app.config.ts`, and the build asks here rather than holding a second copy.
import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from './actor';
import {
  defineMeasurementActor,
  MEASUREMENT_ACTOR_ID,
  measurementActor,
  resetMeasurementActor,
} from './measurement-actor';

afterEach(() => resetMeasurementActor());

describe('unit · the measurement actor', () => {
  test('undeclared, it is a service actor holding every permission and no facts', async () => {
    const actor = await measurementActor();
    expect(actor).toMatchObject({ kind: 'service', id: MEASUREMENT_ACTOR_ID, permissions: ['*'] });
    expect(Object.keys(actor.facts ?? {})).toEqual([]);
  });

  test('declared, the build renders as the app’s own actor — facts included, async allowed', async () => {
    defineMeasurementActor(async () =>
      userActor({ id: 'm-1', roles: ['member'], facts: { measured: true } as never }),
    );
    const actor = await measurementActor();
    expect(actor.id).toBe('m-1');
    expect(actor.roles).toEqual(['member']);
    expect(actor.facts).toEqual({ measured: true } as never);
  });

  test('a factory that answers no actor is refused by name rather than rendered as nobody', async () => {
    defineMeasurementActor(() => undefined as never);
    expect(await measurementActor().catch((e: unknown) => e)).toBeUltimateError('X_INVARIANT');
  });
});
