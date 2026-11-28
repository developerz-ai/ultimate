// A spring as a CSS `linear()` easing: the damped oscillator sampled from rest to settle. The
// token rungs are this function's output COMMITTED (`tokens.ts`, `_motion.scss`), so a CSS spring
// costs no JavaScript; the function ships for an app that wants a rung of its own.

import { invalidValueError } from '../errors';

/** A spring's physics: stiffness k, damping c, mass m — each positive and finite. */
export interface SpringSpec {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

export interface SpringCurve {
  /** `linear(0, …, 1)`: the position at evenly spaced instants from start to settle. */
  readonly easing: string;
  /** Milliseconds until the spring stays inside the rest band. */
  readonly duration: number;
}

/** Inside this distance of the target the spring counts as settled: under a pixel on 1000. */
const REST = 0.001;
/** Ten seconds: a spring that has not settled by then is not a UI spring. */
const MAX_MS = 10_000;
/** One stop per ~60 Hz frame, so the piecewise curve never cuts a corner the eye can see. */
const FRAME_MS = 1000 / 60;
const MIN_STOPS = 12;
const MAX_STOPS = 80;

/**
 * The position of a unit step response x(t), x(0) = 0 → 1, at `t` seconds: the three closed forms
 * of m·x″ + c·x′ + k·(x − 1) = 0 (under-, critically and over-damped).
 */
export function springPosition(spec: SpringSpec, t: number): number {
  const omega = Math.sqrt(spec.stiffness / spec.mass);
  // √k · √m, never √(k m): the product overflows to Infinity long before either factor does.
  const zeta = spec.damping / (2 * Math.sqrt(spec.stiffness) * Math.sqrt(spec.mass));
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * t);
    return 1 - decay * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega + root;
  const r2 = -zeta * omega - root;
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

function assertSpec(spec: SpringSpec): void {
  for (const key of ['stiffness', 'damping', 'mass'] as const) {
    const value = spec[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw invalidValueError(`springLinear ${key}`, value, 'a positive finite number');
    }
  }
}

/** The last millisecond the spring was outside the rest band, plus one. */
function settleMs(spec: SpringSpec): number {
  let last = 0;
  for (let ms = 0; ms <= MAX_MS; ms += 1) {
    if (Math.abs(springPosition(spec, ms / 1000) - 1) >= REST) last = ms;
  }
  return last + 1;
}

/** Four decimals: below what a 4K screen resolves, and the string stays short. */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export function springLinear(spec: SpringSpec): SpringCurve {
  assertSpec(spec);
  const duration = settleMs(spec);
  const count = Math.min(MAX_STOPS, Math.max(MIN_STOPS, Math.ceil(duration / FRAME_MS) + 1));
  const stops: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    stops.push(round(springPosition(spec, ((index / (count - 1)) * duration) / 1000)));
  }
  // The last stop is the target itself, never 0.9997: the animation must END where it says.
  stops.push(1);
  return { easing: `linear(${stops.join(', ')})`, duration };
}
