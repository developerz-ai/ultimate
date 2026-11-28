// The spring generator against the damped oscillator it claims to sample, and the three token
// rungs against the generator: a rung is a COMMITTED literal (0 B of JS for a CSS spring), so the
// literal, the SCSS map and the function must agree or one of them drifted.

import { describe, expect, test } from 'bun:test';
import { UiError } from '../errors';
import { springs } from '../tokens/tokens';
import { springLinear, springPosition } from './spring-linear';

/** The stops of a `linear(…)` string, in order. */
const stops = (curve: string): number[] =>
  (/^linear\((.*)\)$/.exec(curve)?.[1] ?? '').split(',').map((part) => Number(part.trim()));

describe('springPosition — the closed forms', () => {
  test('critical damping is 1 − e^(−ω t)(1 + ω t)', () => {
    // k = 100, m = 1 → ω0 = 10; critical damping is 2·√(k m) = 20.
    const spec = { stiffness: 100, damping: 20, mass: 1 };
    for (const t of [0, 0.05, 0.1, 0.3, 0.8]) {
      expect(springPosition(spec, t)).toBeCloseTo(1 - Math.exp(-10 * t) * (1 + 10 * t), 10);
    }
  });

  test('an underdamped spring overshoots by e^(−ζπ/√(1−ζ²)) at its first peak', () => {
    const spec = { stiffness: 200, damping: 12, mass: 1 };
    const omega = Math.sqrt(200);
    const zeta = 12 / (2 * omega);
    const peakAt = Math.PI / (omega * Math.sqrt(1 - zeta * zeta));
    const overshoot = Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
    expect(springPosition(spec, peakAt)).toBeCloseTo(1 + overshoot, 10);
  });

  test('huge inputs are the same spring as their ratio: k·m never overflows to Infinity', () => {
    // ζ = c / (2√(k m)): with k = m = c = 1e200, √(k m) overflowed and ζ became 0 — undamped.
    const huge = { stiffness: 1e200, damping: 1e200, mass: 1e200 };
    const unit = { stiffness: 1, damping: 1, mass: 1 };
    for (const t of [0.5, 2, 6])
      expect(springPosition(huge, t)).toBeCloseTo(springPosition(unit, t), 10);
  });

  test('an overdamped spring never passes its target', () => {
    const spec = { stiffness: 100, damping: 60, mass: 1 };
    for (let t = 0; t < 3; t += 0.01) expect(springPosition(spec, t)).toBeLessThanOrEqual(1);
  });
});

describe('springLinear', () => {
  test('starts at 0, ends at exactly 1, and carries the bounce of an underdamped spring', () => {
    const { easing } = springLinear(springs.bouncy);
    const points = stops(easing);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1.1);
  });

  test('the duration is where the spring settles, rounded up to a millisecond', () => {
    const spec = springs.snappy;
    const { duration } = springLinear(spec);
    expect(Number.isInteger(duration)).toBe(true);
    // Past the settle point the spring is within the rest band; a frame before it, it is not.
    expect(Math.abs(springPosition(spec, duration / 1000) - 1)).toBeLessThan(0.001);
    expect(Math.abs(springPosition(spec, (duration - 20) / 1000) - 1)).toBeGreaterThan(0.0005);
  });

  test('every stop samples the oscillator at its own instant', () => {
    const spec = springs.gentle;
    const { easing, duration } = springLinear(spec);
    const points = stops(easing);
    const step = duration / 1000 / (points.length - 1);
    points.slice(0, -1).forEach((value, index) => {
      expect(value).toBeCloseTo(springPosition(spec, index * step), 3);
    });
  });

  test('a stiffness, damping or mass that is not a positive finite number is refused', () => {
    for (const bad of [
      { stiffness: 0, damping: 10, mass: 1 },
      { stiffness: 100, damping: -1, mass: 1 },
      { stiffness: 100, damping: 10, mass: Number.NaN },
    ]) {
      expect(() => springLinear(bad)).toThrow(UiError);
    }
  });
});

describe('the token rungs are the generator, committed', () => {
  test('tokens.ts holds exactly what springLinear answers for each rung', () => {
    for (const rung of Object.values(springs)) {
      expect(springLinear(rung)).toEqual({ easing: rung.easing, duration: rung.duration });
    }
  });

  test("_motion.scss's $spring map holds the same curves", async () => {
    const source = await Bun.file(new URL('../tokens/_motion.scss', import.meta.url)).text();
    const block = /\$spring: \(\n([\s\S]*?)\n\);/.exec(source)?.[1] ?? '';
    const scss = Object.fromEntries(
      block
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter((line) => line !== '' && !line.startsWith('//'))
        .map((line) => [
          line.slice(0, line.indexOf(':')),
          line.slice(line.indexOf(':') + 1).trim(),
        ]),
    );
    expect(scss).toEqual(
      Object.fromEntries(Object.entries(springs).map(([name, rung]) => [name, rung.easing])),
    );
  });
});
