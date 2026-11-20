// The cgroup's declared budget, read from fixture text: Docker's measured `cpu.max` shapes and
// cgroup v1's CFS pair, and a ceiling that says `max` reading as unlimited.

import { describe, expect, test } from 'bun:test';
import { CGROUP_PATHS, cpuBudget, memoryCeiling, readCgroup } from './supervise-cgroup';

describe('unit · cpuBudget', () => {
  test.each([
    ['200000 100000\n', 2],
    ['50000 100000', 1],
    ['150000 100000', 1],
    ['350000 100000', 3],
  ])('cgroup v2 cpu.max %p → %p whole CPUs, floored, at least one', (text, cpus) => {
    expect(cpuBudget(text)).toBe(cpus);
  });

  test('`max` is no budget declared, and v1 is not asked over it', () => {
    expect(cpuBudget('max 100000', '400000', '100000')).toBeUndefined();
  });

  test('cgroup v1: a CFS quota over its period; -1 is none', () => {
    expect(cpuBudget(undefined, '300000', '100000')).toBe(3);
    expect(cpuBudget(undefined, '-1', '100000')).toBeUndefined();
    expect(cpuBudget(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('unit · memoryCeiling', () => {
  test('v2 bytes, and `max` as unlimited', () => {
    expect(memoryCeiling('1073741824\n')).toBe(1_073_741_824);
    expect(memoryCeiling('max')).toBeUndefined();
  });

  test("v1's page-aligned 63-bit sentinel is unlimited; a real limit is read", () => {
    expect(memoryCeiling(undefined, '9223372036854771712')).toBeUndefined();
    expect(memoryCeiling(undefined, '536870912')).toBe(536_870_912);
  });
});

describe('unit · readCgroup', () => {
  test('reads the v2 files through the injected reader', async () => {
    const files: Record<string, string> = {
      [CGROUP_PATHS.cpuMax]: '200000 100000',
      [CGROUP_PATHS.memoryMax]: '1073741824',
    };
    expect(await readCgroup(async (path) => files[path])).toEqual({
      cpus: 2,
      memoryBytes: 1_073_741_824,
    });
  });
});
