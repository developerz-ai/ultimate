// The motion token scale, as WAAPI wants it: milliseconds and an easing string, read from the
// RESOLVED `--duration-*` / `--easing-*` so `defineTheme({ motion })` re-tempos a script's
// animation exactly as it does a stylesheet's. Stilled whenever `motionAllowed()` says no.

import {
  type DurationName,
  durationTokens,
  type EasingName,
  easingTokens,
  type SpringName,
  springs,
} from '../tokens/tokens';
import { browserMotionHost, motionAllowed } from './motion-gate';

export interface MotionTiming {
  /** Milliseconds, as `Element.animate` takes them. */
  readonly duration: number;
  readonly easing: string;
}

/** The page, injected: one custom property's resolved value, and the motion gate. */
export interface TimingHost {
  read(property: string): string;
  allowed(): boolean;
}

/** `_motion.scss`'s `$still`: what reduced motion collapses a duration to. Never 0 (no finish). */
export const STILL_MS = 0.01;

const TIME = /^(\d*\.?\d+)(ms|s)$/;

function milliseconds(value: string): number | undefined {
  const match = TIME.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

const isSpring = (name: EasingName | SpringName): name is SpringName => name in springs;

/**
 * `duration` names a rung of the duration scale; `easing` a rung of the easing scale or a spring
 * (`gentle` · `snappy` · `bouncy`, emitted as `--easing-<name>`). Default easing `out`.
 */
export function motionTiming(
  duration: DurationName,
  easing: EasingName | SpringName = 'out',
  host: TimingHost | null = browserTimingHost(),
): MotionTiming {
  const fallbackEasing = isSpring(easing) ? springs[easing].easing : easingTokens[easing];
  const resolvedEasing = host?.read(`--easing-${easing}`).trim() ?? '';
  const curve = resolvedEasing === '' ? fallbackEasing : resolvedEasing;
  if (host === null || !host.allowed()) return { duration: STILL_MS, easing: curve };
  const ms =
    milliseconds(host.read(`--duration-${duration}`)) ??
    (milliseconds(durationTokens[duration]) as number);
  return { duration: ms, easing: curve };
}

function browserTimingHost(): TimingHost | null {
  const motion = browserMotionHost();
  if (motion === null || typeof getComputedStyle !== 'function') return null;
  return {
    read: (property) => getComputedStyle(document.documentElement).getPropertyValue(property),
    allowed: () => motionAllowed(motion),
  };
}
