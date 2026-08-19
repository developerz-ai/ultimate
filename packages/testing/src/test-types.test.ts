// The six typed registrars, exercised by REGISTERING through them. Every helper here calls
// `bun:test`'s own `test()`, so the only honest way to prove one works is to let it register a
// real test and assert on what that registration did — which body ran, which driver was handed
// the call, and whether an eval's threshold is exclusive.

import { afterAll, describe, expect, test } from 'bun:test';
import type { E2eBody } from './test-types';
import {
  contractTest,
  e2eTest,
  evalTest,
  hasE2eDriver,
  jobTest,
  liveTest,
  SEPARATOR,
  TEST_TYPES,
  testName,
  unitTest,
  useE2eDriver,
} from './test-types';

/** Which registrar's body actually ran. A helper that forgot to call `test()` leaves a `0`. */
const ran: Record<string, number> = {};
const mark = (type: string): void => {
  ran[type] = (ran[type] ?? 0) + 1;
};

unitTest('unitTest runs the body it was given', () => {
  mark('unit');
});
contractTest('contractTest runs the body it was given', () => {
  mark('contract');
});
liveTest('liveTest runs the body it was given', () => {
  mark('live');
});
jobTest('jobTest runs the body it was given', () => {
  mark('job');
});

// BEFORE any driver is registered: the body must never run. `e2eTest` reports a skip when nothing
// drives a browser, and a skip that silently executed the body would run an app-less browser test
// in every suite in the tree. This file goes red if that branch stops skipping.
e2eTest('e2eTest skips its body while no driver is registered', () => {
  throw new Error('the e2e body ran with no browser driver registered');
});

const driverCalls: { readonly name: string; readonly body: E2eBody }[] = [];
const registeredBefore = hasE2eDriver();
// Registering here rather than inside a test on purpose: `test()` may only be called while the
// file is being collected, which is exactly the moment a driver would install itself.
useE2eDriver((name, body) => {
  driverCalls.push({ name, body });
});
const registeredAfter = hasE2eDriver();

const e2eBody: E2eBody = async ({ page }) => {
  await page.goto('/');
};
e2eTest('renders offline', e2eBody);

// The passing half of an eval: the threshold is a floor a score may sit exactly on, and the case
// input has to reach `run`. A `run` that ignored its input scores 0 and this test goes red.
evalTest('scores every case against the run under test', {
  threshold: 0.5,
  cases: [
    { name: 'exact', input: 3, score: (output: number) => (output === 6 ? 0.5 : 0) },
    { name: 'async', input: 4, score: (output: number) => Promise.resolve(output === 8 ? 1 : 0) },
  ],
  run: (input: number) => Promise.resolve(input * 2),
});

describe(testName('unit', 'test type names'), () => {
  test('every type prefixes its own name with the separator the verify step reads', () => {
    expect(TEST_TYPES.map((type) => testName(type, 'a case'))).toEqual([
      'unit · a case',
      'contract · a case',
      'live · a case',
      'job · a case',
      'e2e · a case',
      'eval · a case',
    ]);
    expect(SEPARATOR).toBe(' · ');
  });
});

describe(testName('unit', 'the e2e driver seam'), () => {
  test('registering a driver flips hasE2eDriver, which is what a harness reads', () => {
    // If some earlier file had registered one, the throwing `e2eTest` above would have run and
    // failed this file first — so this assertion cannot pass on a stale global.
    expect(registeredBefore).toBe(false);
    expect(registeredAfter).toBe(true);
  });

  test('a registered driver receives the prefixed name and the body verbatim', () => {
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]?.name).toBe('e2e · renders offline');
    // The SAME function, not a wrapper: a driver needs the body to pass its own fixtures to.
    expect(driverCalls[0]?.body).toBe(e2eBody);
  });
});

afterAll(() => {
  // Each registrar registered exactly one test, and each of those bodies ran exactly once.
  expect(ran).toEqual({ unit: 1, contract: 1, live: 1, job: 1 });
});
