// The declaration registry across `x dev`'s rescans: a module re-evaluated in a NEW generation
// re-declares its path and replaces the old value; two declarations inside one generation are
// still two modules claiming one path, and refused — and so is a DIFFERENT module in a later one.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  beginDeviceSocketGeneration,
  declaredDeviceSockets,
  deviceSocket,
  forgetDeviceSockets,
} from './device-socket';

// Before as well: a sibling file in this process may leave its own declarations behind.
beforeEach(() => {
  forgetDeviceSockets();
});
afterEach(() => {
  forgetDeviceSockets();
});

const declare = (path: string) =>
  deviceSocket({ path, resolveToken: () => null, onFrame: () => undefined });

const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return 'declared';
};

describe('unit · deviceSocket generations', () => {
  test('a re-declaration in a new generation replaces the old one, in place', () => {
    const first = declare('/gen-link');
    const other = declare('/gen-other');
    beginDeviceSocketGeneration();
    const second = declare('/gen-link');
    expect(second).not.toBe(first);
    expect(declaredDeviceSockets()).toEqual([second, other]);
  });

  test('a second declaration of one path inside one generation is still X_CONFIG_INVALID', () => {
    declare('/gen-twice');
    expect(codeOf(() => declare('/gen-twice'))).toBe('X_CONFIG_INVALID');
    beginDeviceSocketGeneration();
    expect(codeOf(() => declare('/gen-twice'))).toBe('declared');
    expect(codeOf(() => declare('/gen-twice'))).toBe('X_CONFIG_INVALID');
  });

  test('another module taking a held path in a later generation is X_CONFIG_INVALID', async () => {
    const first = declare('/gen-taken');
    beginDeviceSocketGeneration();
    try {
      await import('./device-declarer-fixture');
    } catch (error) {
      expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_CONFIG_INVALID');
      // Both sides of the collision, by file: the reader has two modules to choose between.
      const cause = isUltimateError(error) ? error.cause : '';
      expect(cause).toContain('device-declarer-fixture.ts');
      expect(cause).toContain('device-socket-generation.test.ts');
      expect(declaredDeviceSockets()).toEqual([first]);
      return;
    }
    expect.unreachable('a second module took the path');
  });
});
