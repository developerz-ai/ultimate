// A script's animation reads the SAME timing the stylesheet does — the resolved custom properties —
// so `defineTheme({ motion })` re-tempos a WAAPI animation exactly as it re-tempos a transition.

import { describe, expect, test } from 'bun:test';
import { durationTokens, easingTokens, springs } from '../tokens/tokens';
import { motionTiming, STILL_MS, type TimingHost } from './motion-timing';

const host = (props: Record<string, string>, allowed = true): TimingHost => ({
  read: (name) => props[name] ?? '',
  allowed: () => allowed,
});

describe('motionTiming', () => {
  test('reads the resolved custom properties, so a theme override applies', () => {
    const timing = motionTiming(
      'base',
      'out',
      host({ '--duration-base': ' 180ms', '--easing-out': ' cubic-bezier(0.2, 0, 0, 1)' }),
    );
    expect(timing).toEqual({ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  });

  test('a duration in seconds is milliseconds to WAAPI', () => {
    expect(motionTiming('slow', 'in', host({ '--duration-slow': '0.3s' })).duration).toBe(300);
  });

  test('with no stylesheet loaded, the token scale answers', () => {
    const timing = motionTiming('fast', 'in-out', host({}));
    expect(timing.duration).toBe(Number.parseFloat(durationTokens.fast));
    expect(timing.easing).toBe(easingTokens['in-out']);
  });

  test('a spring rung is an easing: its resolved curve, else the committed one', () => {
    expect(motionTiming('base', 'snappy', host({ '--easing-snappy': 'linear(0, 1)' })).easing).toBe(
      'linear(0, 1)',
    );
    expect(motionTiming('base', 'bouncy', host({})).easing).toBe(springs.bouncy.easing);
  });

  test('reduced motion or a paused page is $still — never 0, which fires no finish event', () => {
    const timing = motionTiming('slower', 'out', host({ '--duration-slower': '640ms' }, false));
    expect(timing.duration).toBe(STILL_MS);
    expect(STILL_MS).toBeGreaterThan(0);
    expect(STILL_MS).toBe(0.01);
  });

  test('off the DOM: the token scale, stilled — nothing moves on a server', () => {
    expect(motionTiming('base')).toEqual({ duration: STILL_MS, easing: easingTokens.out });
  });
});
