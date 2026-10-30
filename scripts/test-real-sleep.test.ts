// The failure case first, then what must never be one — a turn, a moved clock, prose, a fixture
// string, a stated reason — and the ratchet's other two answers. Every input is built by hand: a
// test that edits a real test file to prove the rule fires races the gate it guards.

import { describe, expect, test } from 'bun:test';
import {
  callArguments,
  checkRealSleeps,
  type RealSleepGap,
  realSleepFindingFor,
  scanRealSleeps,
} from './test-real-sleep';

const PATH = 'packages/x/src/a.test.ts';
const scan = (...lines: string[]) => scanRealSleeps(PATH, lines.join('\n'));

describe('scanRealSleeps', () => {
  test('a wall-clock wait is reported, by its line and as written', () => {
    const found = scan(
      "test('x', async () => {",
      '  await Bun.sleep(30);',
      '  await new Promise((resolve) => setTimeout(resolve, 50));',
      '  const id = setInterval(tick, 5);',
      '  Bun.sleepSync(1);',
      '  await new Promise((r) => globalThis.setTimeout(r, POLL_MS * 2));',
      '});',
    );
    expect(found.map((site) => [site.line, site.call])).toEqual([
      [2, 'Bun.sleep(30)'],
      [3, 'setTimeout(…, 50)'],
      [4, 'setInterval(…, 5)'],
      [5, 'Bun.sleepSync(1)'],
      [6, 'setTimeout(…, POLL_MS * 2)'],
    ]);
  });

  test('a wait spread over several lines is one wait', () => {
    const found = scan('setTimeout(', '  () => resolve(undefined),', '  RETRY_MS * 4,', ');');
    expect(found.map((site) => site.call)).toEqual(['setTimeout(…, RETRY_MS * 4)']);
  });

  test('an event-loop turn, a moved clock and another object are not waits', () => {
    expect(
      scan(
        'await new Promise((resolve) => setTimeout(resolve, 0));',
        'await new Promise((r) => setTimeout(r, 1));',
        'setTimeout(land);',
        'await Bun.sleep(0);',
        'await new Promise((resolve) => setImmediate(resolve));',
        'jest.advanceTimersByTime(5_000);',
        'await clock.sleep(700);',
        'timers.setInterval(run, 5_000);',
        'clearTimeout(timer);',
      ),
    ).toEqual([]);
  });

  test('a stated reason on the line or the one above keeps it; a bare marker does not', () => {
    expect(
      scan(
        '// real-clock: the browser is another process',
        'await Bun.sleep(POLL_MS);',
        'await Bun.sleep(10); // real-clock: the server takes its own time',
      ),
    ).toEqual([]);
    expect(scan('// real-clock:', 'await Bun.sleep(POLL_MS);')).toHaveLength(1);
    expect(scan('// real-clock: a child process', '', 'await Bun.sleep(5);')).toHaveLength(1);
  });

  test('a wait inside a string or a comment is text, not a call', () => {
    expect(
      scan(
        "const fixture = 'await Bun.sleep(30); setTimeout(r, 50)';",
        '// await Bun.sleep(1_000) was the old way',
        '/* setTimeout(resolve, 20) */',
      ),
    ).toEqual([]);
  });

  test('a delimiter inside an argument string does not hide the delay (review #931)', () => {
    expect(scan(`setTimeout(() => log(")"), 50);`, "setInterval(() => log('],'), 20);")).toEqual([
      { path: PATH, line: 1, call: 'setTimeout(…, 50)' },
      { path: PATH, line: 2, call: 'setInterval(…, 20)' },
    ]);
  });

  test('callArguments splits only the top level', () => {
    expect(callArguments('f(a, g(b, c), [d, e])', 1)).toEqual(['a', ' g(b, c)', ' [d, e]']);
    expect(callArguments('f()', 1)).toEqual(['']);
    expect(callArguments('f(a', 1)).toBeUndefined();
  });
});

describe('the ratchet', () => {
  const files = [{ path: PATH, text: 'await Bun.sleep(30);\nawait Bun.sleep(40);\n' }];

  test('over its pin is X_TEST_REAL_SLEEP, naming the site and how to move time', () => {
    const gaps = checkRealSleeps({ files, pins: { x: 1 } });
    expect(gaps.map((gap) => [gap.kind, gap.pkg, gap.found, gap.pinned])).toEqual([
      ['over', 'x', 2, 1],
    ]);
    const finding = realSleepFindingFor(gaps[0] as RealSleepGap);
    expect(finding.code).toBe('X_TEST_REAL_SLEEP');
    expect(finding.cause).toContain('Bun.sleep(30)');
    expect(finding.fix).toContain('jest.advanceTimersByTime');
    expect(finding.fix).toContain('// real-clock:');
  });

  test('a pin above the tree is stale, and a corpus that read nothing is unscanned', () => {
    const stale = checkRealSleeps({ files, pins: { x: 5 } });
    expect(stale.map((gap) => gap.kind)).toEqual(['stale']);
    expect(realSleepFindingFor(stale[0] as RealSleepGap).code).toBe('X_TEST_REAL_SLEEP_PIN_STALE');
    const none = checkRealSleeps({ files: [], pins: {} });
    expect(none.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(realSleepFindingFor(none[0] as RealSleepGap).code).toBe('X_TEST_REAL_SLEEP_UNSCANNED');
    expect(checkRealSleeps({ files, pins: { x: 2 } })).toEqual([]);
  });
});
