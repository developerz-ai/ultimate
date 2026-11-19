// The port a refusal suggests: free for both roles `x dev` binds, or the fix fails a second time.

import { describe, expect, test } from 'bun:test';
import { freeDevPortPair } from './dev-lock-free-port';
import { PORT_RANGE } from './flag-number';

const freeExcept =
  (...taken: readonly number[]) =>
  (port: number): boolean =>
    !taken.includes(port);

describe('freeDevPortPair', () => {
  test('nothing else taken: the next pair', async () => {
    expect(await freeDevPortPair(3000, freeExcept(3000, 3001))).toBe(3002);
  });

  test('walks past a pair whose web port is taken', async () => {
    expect(await freeDevPortPair(3000, freeExcept(3000, 3001, 3002, 3003))).toBe(3004);
  });

  test('walks past a pair where only the sync port is taken', async () => {
    expect(await freeDevPortPair(3000, freeExcept(3000, 3003))).toBe(3004);
  });

  test('accepts an async probe', async () => {
    expect(await freeDevPortPair(3000, async (port) => port >= 3006)).toBe(3006);
  });

  test('at the top of the range it walks down, and every answer has a sync port', async () => {
    const top = PORT_RANGE.max - 2;
    expect(await freeDevPortPair(top, freeExcept(top - 2))).toBe(top - 4);
  });

  test('a machine with nothing free keeps the plain suggestion', async () => {
    expect(await freeDevPortPair(3000, () => false)).toBe(3002);
  });
});
