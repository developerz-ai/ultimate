// The wait's floor after a refused event is a cursor past THAT event, not past its millisecond:
// a valid event published in the same ms is still the wait's answer (memory bus).

import { expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { memoryEventBus } from './events';
import { refusedThenValidSameMs } from './steps-wait-cursor-fixture';

const T0 = 1_760_000_000_000;
const frozen: Clock = { now: () => new Date(T0) } as Clock;

test('a valid event in the refused one’s millisecond is the answer, not skipped (memory)', async () => {
  const bus = memoryEventBus({ clock: frozen });
  const answer = await refusedThenValidSameMs(bus, frozen, async () => {
    await bus.publish('invoice.approved', { amount: 'twelve' });
    await bus.publish('invoice.approved', { amount: 12 });
  });
  expect(answer).toEqual({ amount: 12 });
});

test('the cursor seeks past the event it names, and the earliest stays first', async () => {
  const bus = memoryEventBus({ clock: frozen });
  const first = await bus.publish('e', 1);
  const second = await bus.publish('e', 2);
  expect(await bus.find('e', undefined, T0)).toMatchObject({ id: first.id, payload: 1 });
  expect(await bus.find('e', undefined, T0, first.id)).toMatchObject({ id: second.id, payload: 2 });
  expect(await bus.find('e', undefined, T0, second.id)).toBeUndefined();
});
