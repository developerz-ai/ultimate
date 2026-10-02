// State the preload puts back before EVERY test, not every file. Two tests here publish and read
// one event name: without the reset the second reads the first's answer — exactly how a prompt a
// test answered resumed the next test's waiting run.

import { describe, expect, test } from 'bun:test';
import { eventBus, publishEvent } from '@ultimat3/jobs';
import { installPerTestReset } from './per-test-reset';
import { testName } from './test-types';

// What the app preload does once per process; the framework repository's own preload is another
// file, so this one installs it for itself. Installing twice registers one hook.
installPerTestReset();
installPerTestReset();

describe(testName('unit', 'the event bus is the test’s own'), () => {
  test('a test publishes an answer under a shared name', async () => {
    await publishEvent('prompt.answered', { answer: 'yes' }, { correlationKey: 'run-1' });
    expect(await eventBus().list('prompt.answered')).toHaveLength(1);
  });

  test('the next test sees none of it', async () => {
    expect(await eventBus().list('prompt.answered')).toEqual([]);
    await publishEvent('prompt.answered', { answer: 'no' }, { correlationKey: 'run-1' });
    expect(await eventBus().list('prompt.answered')).toHaveLength(1);
  });
});
