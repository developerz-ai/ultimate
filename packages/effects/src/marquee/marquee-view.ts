// Marquee's inputs, validated once: how long one loop takes and the gap between items. Everything
// else (pause on hover/focus/toggle, RTL) is CSS, so the strip works with no script at all.

import { EffectsInvalidValueError } from '../errors';

export const MARQUEE_BACKEND = 'css';
export const MARQUEE_DEFAULT_SECONDS = 30;

export function marqueeSeconds(requested: number | undefined): number {
  if (requested === undefined) return MARQUEE_DEFAULT_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new EffectsInvalidValueError({
      cause: `Marquee seconds must be a positive finite number, got ${String(requested)}.`,
      fix: `<Marquee seconds={${MARQUEE_DEFAULT_SECONDS}}>{() => 'item'}</Marquee>   // seconds > 0 for one loop, or omit seconds`,
    });
  }
  return requested;
}

export function marqueeVars(seconds: number | undefined, reverse: boolean): Record<string, string> {
  return {
    '--marquee-seconds': `${marqueeSeconds(seconds)}s`,
    '--marquee-direction': reverse ? 'reverse' : 'normal',
  };
}
