// The CPU half of admission as a pure decision: when a run that fits in memory still waits, and the
// two rules that keep the queue moving whatever the machine is doing.

import { describe, expect, test } from 'bun:test';
// why: the same synchronous read `heavy-pressure.ts` makes of `/proc/pressure/cpu`.
import { readFileSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  CPU_SOME_BUSY_PERCENT,
  CPU_WAIT_LIMIT_MS,
  cpuAdmission,
  cpuGateOn,
  cpuText,
  parseCpuSome,
  RUNNABLE_PER_CORE_BUSY,
  readCpuPressure,
} from './heavy-pressure';

const PSI = (avg10: number) =>
  `some avg10=${avg10.toFixed(2)} avg60=1.00 avg300=1.00 total=5\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
/** A kernel with no PSI: the real read of a file that is not there, as `/proc/pressure/cpu` is. */
const noPsi = (): string => readFileSync(join(import.meta.dir, 'no-such-pressure', 'cpu'), 'utf8');

describe('reading the pressure', () => {
  test('PSI `cpu some` avg10 is the signal where the kernel has it', () => {
    expect(parseCpuSome(PSI(95.83))).toBe(95.83);
    expect(parseCpuSome('nonsense')).toBeUndefined();
    expect(readCpuPressure({ read: () => PSI(95.83), cores: 8, runnable: 0 })).toEqual({
      source: 'psi',
      value: 95.83,
      limit: CPU_SOME_BUSY_PERCENT,
      busy: true,
    });
  });

  test('the limit itself is busy, just below it is not', () => {
    const at = (value: number) =>
      readCpuPressure({ read: () => PSI(value), cores: 8, runnable: 0 });
    expect(at(CPU_SOME_BUSY_PERCENT).busy).toBe(true);
    expect(at(CPU_SOME_BUSY_PERCENT - 0.01).busy).toBe(false);
  });

  test('without PSI it falls back to runnable tasks per core', () => {
    const at = (runnable: number) => readCpuPressure({ read: noPsi, cores: 8, runnable });
    expect(at(8 * RUNNABLE_PER_CORE_BUSY)).toMatchObject({
      source: 'runnable',
      value: 2,
      busy: true,
    });
    expect(at(8 * RUNNABLE_PER_CORE_BUSY - 1).busy).toBe(false);
  });

  test('the reason names the figure and the limit', () => {
    const psi = readCpuPressure({ read: () => PSI(95.83), cores: 8, runnable: 0 });
    expect(cpuText(psi)).toBe('CPU pressure 96% (new runs wait at 80%)');
    const queue = readCpuPressure({ read: noPsi, cores: 8, runnable: 69 });
    expect(cpuText(queue)).toBe('8.6 runnable tasks per core (new runs wait at 2)');
  });
});

describe('the decision', () => {
  const busy = readCpuPressure({ read: () => PSI(99), cores: 8, runnable: 0 });
  const calm = readCpuPressure({ read: () => PSI(5), cores: 8, runnable: 0 });

  test('a calm machine admits beside running work', () => {
    expect(cpuAdmission({ reading: calm, running: 3, blockedMs: 0 })).toBe('admit');
  });

  test('a busy machine holds a run back while another is running', () => {
    expect(cpuAdmission({ reading: busy, running: 1, blockedMs: 0 })).toBe('wait');
  });

  test('with nothing admitted one run always goes, even under outside pressure', () => {
    expect(cpuAdmission({ reading: busy, running: 0, blockedMs: 0 })).toBe('admit');
  });

  test('a long holder cannot starve the head: the wait on CPU is bounded', () => {
    const near = { reading: busy, running: 1, blockedMs: CPU_WAIT_LIMIT_MS - 1 };
    expect(cpuAdmission(near)).toBe('wait');
    expect(cpuAdmission({ ...near, blockedMs: CPU_WAIT_LIMIT_MS })).toBe('admit');
  });

  test('no reading is no reason to wait', () => {
    expect(cpuAdmission({ reading: undefined, running: 4, blockedMs: 0 })).toBe('admit');
  });
});

describe('where the gate applies', () => {
  test('on for a local run; off in CI, inside a test run and by the switch', () => {
    expect(cpuGateOn({}, {})).toBe(true);
    expect(cpuGateOn({ CI: 'true' }, {})).toBe(false);
    expect(cpuGateOn({ ULTIMATE_HEAVY_CPU: '0' }, {})).toBe(false);
    expect(cpuGateOn({ NODE_ENV: 'test' }, {})).toBe(false);
    expect(cpuGateOn({}, { NODE_ENV: 'test' })).toBe(false);
  });
});
