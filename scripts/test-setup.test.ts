// The framework repository's own preload puts the jobs event bus back before every test, as an
// app's does: nothing here installs the reset, so only `test-setup.ts` can make the second test
// see an empty bus.

import { describe, expect, test } from 'bun:test';
import { eventBus, publishEvent } from '@ultimat3/jobs';

describe('the repo preload resets the event bus per test', () => {
  test('a test publishes an answer under a shared name', async () => {
    await publishEvent('preload.answered', { answer: 'yes' }, { correlationKey: 'run-1' });
    expect(await eventBus().list('preload.answered')).toHaveLength(1);
  });

  test('the next test sees none of it', async () => {
    expect(await eventBus().list('preload.answered')).toEqual([]);
  });
});
