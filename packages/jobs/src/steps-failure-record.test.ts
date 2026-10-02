// A failed step is recorded on the way out, and the record is bookkeeping: the retry decision is
// made on the STEP's error, so a store that cannot take the `failed` row must not replace it.

import { describe, expect, test } from 'bun:test';
import type { StepRecord, StepStore } from './steps';
import { createStepRunner } from './steps';
import { createMemoryStepStore } from './steps-memory';

class CardDeclined extends Error {}

/** A store that takes everything but a `failed` record — the pool dying under the bookkeeping. */
function storeRefusingFailures(): StepStore & { readonly refused: StepRecord[] } {
  const inner = createMemoryStepStore();
  const refused: StepRecord[] = [];
  return {
    ...inner,
    refused,
    put(record) {
      if (record.status !== 'failed') return inner.put(record);
      refused.push(record);
      return Promise.reject(new Error('connection terminated'));
    },
  };
}

describe('a step whose failure cannot be recorded', () => {
  test('still rejects with the step body error, never the store error', async () => {
    const store = storeRefusingFailures();
    const runner = createStepRunner({ runId: 'run-f', jobName: 'charge', store });
    const original = new CardDeclined('card declined');

    const thrown = await runner.step
      .run('charge', () => Promise.reject(original))
      .catch((error: unknown) => error);

    expect(thrown).toBe(original);
    expect(store.refused.map((record) => record.name)).toEqual(['charge']);
  });

  test('the unrecorded failure costs nothing later: the retry runs the body again', async () => {
    const store = storeRefusingFailures();
    await createStepRunner({ runId: 'run-g', jobName: 'charge', store })
      .step.run('charge', () => Promise.reject(new CardDeclined('card declined')))
      .catch((error: unknown) => error);

    let calls = 0;
    const output = await createStepRunner({ runId: 'run-g', jobName: 'charge', store }).step.run(
      'charge',
      () => {
        calls += 1;
        return 'ok';
      },
    );
    expect(output).toBe('ok');
    expect(calls).toBe(1);
    expect((await store.get('run-g', 'charge'))?.attempts).toBe(1);
  });
});
