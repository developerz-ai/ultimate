// How many tracked apps the reference-app gate builds and verifies at once, and when it must not.

import { describe, expect, test } from 'bun:test';
import { appJobs, gateWidth, sharedServices } from './app-gate-schedule';

const GIB = 1024 ** 3;
const KEYS = ['TEST_DATABASE_URL', 'TEST_REDIS_URL', 'DATABASE_URL'] as const;

describe('gateWidth · shared services force one gate at a time', () => {
  test('a sourced TEST_DATABASE_URL serialises the gates, however wide --jobs is', () => {
    const shared = sharedServices({ TEST_DATABASE_URL: 'postgres://x/postgres' }, KEYS);
    expect(shared).toEqual(['TEST_DATABASE_URL']);
    expect(gateWidth(8, shared)).toBe(1);
  });

  test('DATABASE_URL counts: the template database falls back to it', () => {
    expect(sharedServices({ DATABASE_URL: 'postgres://x/app' }, KEYS)).toEqual(['DATABASE_URL']);
  });

  test('an empty value is unset, and keys outside the list never serialise', () => {
    const shared = sharedServices({ TEST_REDIS_URL: '', PATH: '/usr/bin' }, KEYS);
    expect(shared).toEqual([]);
    expect(gateWidth(3, shared)).toBe(3);
  });
});

describe('appJobs · the width, bounded by cores and memory', () => {
  test('a --jobs that is not a positive integer is refused, never read as the default', () => {
    for (const raw of ['0', '-2', '1.5', 'many', '', true]) {
      expect(appJobs(raw, 16, 64 * GIB)).toBeUndefined();
    }
  });

  test('an explicit --jobs wins over both bounds', () => {
    expect(appJobs('5', 2, 4 * GIB)).toBe(5);
  });

  test('a 4-core, 16 GB box runs one app at a time', () => {
    expect(appJobs(undefined, 4, 16 * GIB)).toBe(1);
  });

  test('a 16-core, 62 GB box runs four', () => {
    expect(appJobs(undefined, 16, 62 * GIB)).toBe(4);
  });

  test('memory bounds a many-core box with little RAM', () => {
    expect(appJobs(undefined, 32, 16 * GIB)).toBe(2);
  });

  test('never below one', () => {
    expect(appJobs(undefined, 1, 1 * GIB)).toBe(1);
  });
});
