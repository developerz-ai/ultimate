// A push the observed call sent is one of its effects, counted per push service host — so a
// notifier whose pusher sends nothing reads as an effect-less reach, never as a delivered push.

import { describe, expect, test } from 'bun:test';
import type { InstrumentEventMap } from '@ultimat3/core';
import { instrument } from '@ultimat3/core';
import { mergeObserved } from './exercise-observed';
import type { ExerciseRoom, Observed } from './exercise-report';
import { openExerciseRoom } from './exercise-report';
import { testName } from './test-types';

const sent = (vendor: string, host: string): InstrumentEventMap['outbound.request'] => ({
  vendor,
  method: 'POST',
  host,
  status: 201,
  durationMs: 0,
});

const observed = async (room: ExerciseRoom, fn: () => Promise<unknown>): Promise<Observed> => {
  const seen = await room.observe('notify', fn);
  if ('error' in seen) return expect.unreachable('the observed call answered');
  return seen.observed;
};

describe(testName('unit', 'exercise room push effects'), () => {
  test('each push the call sent is a push effect of its host, counted', async () => {
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => {
      instrument('outbound.request', sent('push', 'fcm.googleapis.com'));
      instrument('outbound.request', sent('push', 'fcm.googleapis.com'));
    });
    expect(seen.effects).toEqual([{ kind: 'push', host: 'fcm.googleapis.com', count: 2 }]);
  });

  test('a pusher that sends nothing leaves no effect', async () => {
    await using room = await openExerciseRoom();
    const seen = await observed(room, async () => undefined);
    expect(seen.effects).toEqual([]);
  });

  test('another vendor’s call is not a push, and a push outside the call is not the call’s', async () => {
    await using room = await openExerciseRoom();
    instrument('outbound.request', sent('push', 'fcm.googleapis.com'));
    const seen = await observed(room, async () => {
      instrument('outbound.request', sent('resend', 'api.resend.com'));
    });
    expect(seen.effects).toEqual([]);
  });

  test('two calls’ pushes merge into one count, as two mails do', async () => {
    await using room = await openExerciseRoom();
    const push = async (): Promise<void> => {
      instrument('outbound.request', sent('push', 'fcm.googleapis.com'));
    };
    const merged = mergeObserved([await observed(room, push), await observed(room, push)]);
    expect(merged.effects).toEqual([{ kind: 'push', host: 'fcm.googleapis.com', count: 2 }]);
  });
});
