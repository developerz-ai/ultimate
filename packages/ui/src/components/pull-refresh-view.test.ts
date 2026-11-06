import { describe, expect, test } from 'bun:test';
import { PULL_IDLE, PULL_MAX, PULL_THRESHOLD, pullDistance, pullStep } from './pull-refresh-view';

describe('pullDistance', () => {
  test('nothing for no pull, rising, and never past the maximum', () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(Number.NaN)).toBe(0);
    expect(pullDistance(40)).toBeGreaterThan(pullDistance(20));
    expect(pullDistance(10_000)).toBeLessThanOrEqual(PULL_MAX);
  });
});

describe('pullStep', () => {
  const pulling = pullStep(PULL_IDLE, { type: 'start', atTop: true, touch: true });

  test('a pull starts only at the top, only by touch', () => {
    expect(pulling.kind).toBe('pulling');
    expect(pullStep(PULL_IDLE, { type: 'start', atTop: false, touch: true })).toBe(PULL_IDLE);
    expect(pullStep(PULL_IDLE, { type: 'start', atTop: true, touch: false })).toBe(PULL_IDLE);
  });

  test('released past the threshold refreshes; short of it, nothing', () => {
    const far = pullStep(pulling, { type: 'move', dy: 400 });
    expect(far).toMatchObject({ armed: true });
    expect(pullStep(far, { type: 'end' })).toEqual({ kind: 'refreshing' });
    const near = pullStep(pulling, { type: 'move', dy: PULL_THRESHOLD / 2 });
    expect(pullStep(near, { type: 'end' })).toBe(PULL_IDLE);
  });

  test('a second pull while refreshing does nothing, and settling returns to idle', () => {
    const refreshing = { kind: 'refreshing' } as const;
    expect(pullStep(refreshing, { type: 'start', atTop: true, touch: true })).toBe(refreshing);
    expect(pullStep(refreshing, { type: 'settled' })).toBe(PULL_IDLE);
  });
});
