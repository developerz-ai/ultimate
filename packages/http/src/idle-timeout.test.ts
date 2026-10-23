// The derivation alone; that a real socket honours it is `e2e/idle-timeout.e2e.test.ts`.
import { describe, expect, test } from 'bun:test';
import {
  BUN_MAX_IDLE_TIMEOUT_S,
  IDLE_TIMEOUT_MARGIN_S,
  socketIdleTimeoutSeconds,
} from './idle-timeout';

describe('socketIdleTimeoutSeconds', () => {
  test('the default 30 s deadline outlives the 10 s Bun default', () => {
    expect(socketIdleTimeoutSeconds(30_000)).toBe(30 + IDLE_TIMEOUT_MARGIN_S);
    expect(socketIdleTimeoutSeconds(30_000)).toBeGreaterThan(10);
  });

  test('a fractional second rounds up, so the socket never closes before the deadline', () => {
    expect(socketIdleTimeoutSeconds(1)).toBe(1 + IDLE_TIMEOUT_MARGIN_S);
    expect(socketIdleTimeoutSeconds(25_001)).toBe(26 + IDLE_TIMEOUT_MARGIN_S);
  });

  test('no deadline is no idle cut', () => {
    expect(socketIdleTimeoutSeconds(0)).toBe(0);
  });

  test('a deadline Bun cannot hold disables the idle cut instead of clamping under it', () => {
    const largest = (BUN_MAX_IDLE_TIMEOUT_S - IDLE_TIMEOUT_MARGIN_S) * 1_000;
    expect(socketIdleTimeoutSeconds(largest)).toBe(BUN_MAX_IDLE_TIMEOUT_S);
    expect(socketIdleTimeoutSeconds(largest + 1)).toBe(0);
    expect(socketIdleTimeoutSeconds(2_147_483_647)).toBe(0);
  });

  test('a non-number is no deadline, never NaN handed to Bun', () => {
    expect(socketIdleTimeoutSeconds(Number.NaN)).toBe(0);
    expect(socketIdleTimeoutSeconds(-5)).toBe(0);
  });
});
