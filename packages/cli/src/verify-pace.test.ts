import { describe, expect, test } from 'bun:test';
import { TEST_PACE_ENV } from '@ultimat3/testing';
import {
  BUN_TEST_TIMEOUT_MS,
  DECLARED_PACE,
  defaultTimeoutArgs,
  PROBE_RUNS,
  pacedMs,
  paceEnv,
  paceOf,
  probeMs,
  probeWork,
  REFERENCE_CPUS,
  REFERENCE_PROBE_MS,
} from './verify-pace';
import { testStepCommand } from './verify-tests';

describe('the pace a machine runs the gate at', () => {
  test('the reference runner, and anything wider or faster, is pace 1 — never a tighter number', () => {
    expect(paceOf(REFERENCE_CPUS, REFERENCE_PROBE_MS).factor).toBe(1);
    expect(paceOf(16, REFERENCE_PROBE_MS / 3).factor).toBe(1);
  });

  test('fewer cores and a slower core multiply', () => {
    // The fleet box of 2026-10-19: 2 cores, each about 2.5x slower than the runner's.
    expect(paceOf(2, REFERENCE_PROBE_MS * 2.5)).toEqual({
      factor: 5,
      cpus: 2,
      probeMs: REFERENCE_PROBE_MS * 2.5,
    });
    expect(paceOf(1, REFERENCE_PROBE_MS).factor).toBe(REFERENCE_CPUS);
    expect(paceOf(REFERENCE_CPUS, REFERENCE_PROBE_MS * 1.333).factor).toBe(1.33);
  });

  test('a declared number at a pace is that number times the factor, whole milliseconds', () => {
    expect(pacedMs(300_000, DECLARED_PACE)).toBe(300_000);
    expect(pacedMs(5_000, paceOf(REFERENCE_CPUS, REFERENCE_PROBE_MS * 1.333))).toBe(6_650);
  });

  test('the probe is the median of its timed runs, after one it does not count', () => {
    let calls = 0;
    const work = (): number => {
      calls += 1;
      return calls;
    };
    expect(probeMs(work)).toBeGreaterThanOrEqual(0);
    expect(calls).toBe(PROBE_RUNS + 1);
    // The real work does something the optimizer cannot drop: its answer depends on all of it.
    expect(probeWork()).toBe(1_000);
  });
});

describe('what a test run at that pace is started with', () => {
  test('pace 1 or unmeasured: the argv a developer types, with no --timeout of its own', () => {
    expect(defaultTimeoutArgs(undefined)).toEqual([]);
    expect(defaultTimeoutArgs(DECLARED_PACE)).toEqual([]);
    expect(testStepCommand('unit')).toEqual(testStepCommand('unit', DECLARED_PACE));
  });

  test("a slower machine stretches Bun's 5 s default, on every suite", () => {
    const pace = paceOf(2, REFERENCE_PROBE_MS * 3);
    const flag = `--timeout=${String(BUN_TEST_TIMEOUT_MS * 6)}`;
    expect(defaultTimeoutArgs(pace)).toEqual([flag]);
    expect(testStepCommand('unit', pace)).toContain(flag);
    expect(testStepCommand('job', pace)).toContain(flag);
    expect(testStepCommand('live', pace)).toContain(flag);
  });

  test("e2e's own 60 s is the number stretched, never replaced by the 5 s one", () => {
    expect(testStepCommand('e2e')).toContain('--timeout=60000');
    expect(testStepCommand('e2e', paceOf(2, REFERENCE_PROBE_MS * 3))).toContain('--timeout=360000');
  });

  test('the measured pace reaches the test process, at 1 too; nothing when none was measured', () => {
    expect(paceEnv(undefined)).toEqual({});
    expect(paceEnv(DECLARED_PACE)).toEqual({ [TEST_PACE_ENV]: '1' });
    expect(paceEnv(paceOf(2, REFERENCE_PROBE_MS * 3))).toEqual({ [TEST_PACE_ENV]: '6' });
  });
});
