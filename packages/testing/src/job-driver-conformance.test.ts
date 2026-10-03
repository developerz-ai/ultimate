// The conformance suite over the memory driver, and the proof it can fail: a `claim` that drops
// `onExhausted` or `dropExhausted` on the floor — what a hand-written driver did and compiled.

import { describe, expect, test } from 'bun:test';
import type { ClaimOptions, JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver } from '@ultimat3/jobs';
import { JOB_DRIVER_CHECKS } from './job-driver-checks';
import { jobDriverConformance } from './job-driver-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory job driver'), () => {
  behavesLike(jobDriverConformance, () => createMemoryDriver());
});

/** The memory driver with one claim option stripped before it arrives. */
const ignoring = (option: keyof ClaimOptions): JobDriver => {
  const inner = createMemoryDriver();
  return {
    ...inner,
    claim: (options) => inner.claim({ ...options, [option]: undefined }),
  };
};

const check = (name: string) => {
  const found = JOB_DRIVER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a driver that ignores the burial contract fails conformance'), () => {
  test('a claim that never reports what it buried', async () => {
    const burial = check('a lease lapsed on the final attempt');
    await expect(burial.run(ignoring('onExhausted'))).rejects.toThrow();
    await burial.run(createMemoryDriver());
  });

  test('a claim that buries every exhausted row dead, dropExhausted or not', async () => {
    const drop = check('dropExhausted');
    await expect(drop.run(ignoring('dropExhausted'))).rejects.toThrow();
    await drop.run(createMemoryDriver());
  });

  test('every check has a name of its own', () => {
    const names = JOB_DRIVER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
