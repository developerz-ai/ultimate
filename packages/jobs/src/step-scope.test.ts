// `currentStep()` names the step whose body is running, across its awaits, and nothing outside one:
// what a crash proof reads to say a call out was made INSIDE a step, not between two of them.

import { expect, test } from 'bun:test';
import { currentStep } from './step-scope';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

// A foreign failure handed to the subject: test input, never its verdict.
const REFUSED = new TypeError('the provider refused');

test('a body reads its own step across an await; the run outside a step reads none', async () => {
  const runner = stepRunner({ runId: 'run-scope', jobName: 'scoped', store: memoryStepStore() });
  const seen: (string | undefined)[] = [currentStep()];
  await runner.step.run('charge', async () => {
    await Promise.resolve();
    seen.push(currentStep());
    return 1;
  });
  seen.push(currentStep());
  await runner.step
    .run('mail', async () => {
      await Promise.resolve();
      seen.push(currentStep());
      return Promise.reject(REFUSED);
    })
    .catch(() => undefined);
  expect(seen).toEqual([undefined, 'charge', undefined, 'mail']);
});
