// The claim-answer checks can fail: a driver that never says when an empty claim's next row is
// due, or that hands a claimed row out without its steps, is caught — the memory driver passes.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver } from '@ultimat3/jobs';
import { CLAIM_ANSWER_CHECKS } from './job-driver-checks-claim';

const check = (name: string) => {
  const found = CLAIM_ANSWER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no claim check named ${name}`);
  return found;
};

describe('the claim-answer checks', () => {
  test('fail a claim that never tells an empty pass when the next row is due', async () => {
    const inner = memoryJobDriver();
    const silent: JobDriver = {
      ...inner,
      claim: ({ onEmpty: _onEmpty, ...options }) => inner.claim(options),
    };
    const horizon = check('an empty claim says');
    await expect(horizon.run(silent)).rejects.toThrow();
    await horizon.run(memoryJobDriver());
  });

  test("fail a claim that hands a row out without its run's steps", async () => {
    const inner = memoryJobDriver();
    const bare: JobDriver = {
      ...inner,
      claim: async (options) =>
        (await inner.claim(options)).map(({ steps: _steps, ...row }) => row),
    };
    const steps = check('a claimed row carries');
    await expect(steps.run(bare)).rejects.toThrow();
    await steps.run(memoryJobDriver());
  });
});
