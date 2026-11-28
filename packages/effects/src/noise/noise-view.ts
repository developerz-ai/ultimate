// Noise's rules: the grain's opacity, screened, and the fixed turbulence it is drawn from. Still
// by nature — an SVG filter, no animation and no frame loop — so its tier is `static` everywhere.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import { rangeProp, rolesProp } from '../props';

export const NOISE_BACKEND: EffectBackend = 'static';

/** `feTurbulence` inputs. Fixed: a seed that moved would be an animation this entry promises not to be. */
export const NOISE_TURBULENCE = Object.freeze({
  baseFrequency: '0.8',
  numOctaves: '3',
  seed: '7',
});

/** RGB dropped, alpha = 3 x luminance - 1: the grain keeps its contrast, the tint is the role's. */
export const NOISE_ALPHA_MATRIX = '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 1 1 0 -1';

export interface NoiseInput {
  readonly opacity?: number | undefined;
  readonly role?: ColorRole | undefined;
}

export interface NoiseView {
  readonly vars: Record<string, string>;
}

export function noiseView(input: NoiseInput): NoiseView {
  const opacity = rangeProp('Noise', 'opacity', input.opacity, { min: 0, max: 1, fallback: 0.12 });
  const [role = 'fg'] = rolesProp(
    'Noise',
    input.role === undefined ? undefined : [input.role],
    ['fg'],
    { min: 1, max: 1 },
  );
  return { vars: { '--fx-opacity': String(opacity), '--fx-c0': `var(--color-${role})` } };
}
