// Which tier draws an effect: the one decision behind `data-effect-backend`. Static under reduced
// motion or a user pause; CSS before hydration (or when that is all an entry has); then the best
// context the island actually got. "No WebGL2" is a backend, never an error.

export const EFFECT_BACKENDS = ['static', 'css', 'canvas', 'webgl2'] as const;

export type EffectBackend = (typeof EFFECT_BACKENDS)[number];

/** The richest tier an entry can draw with. A canvas entry never climbs to WebGL2. */
export type EffectWants = 'css' | 'canvas' | 'webgl2';

export interface BackendInput {
  /** `motionAllowed()`: false under `prefers-reduced-motion`, `data-motion="paused"`. */
  readonly motion: boolean;
  /** An island after mount. A server render, or an island before it, is not. */
  readonly hydrated: boolean;
  /** Whether the entry's own stylesheet animates its server frame. */
  readonly css: boolean;
  readonly wants: EffectWants;
  readonly webgl2: boolean;
  readonly canvas: boolean;
  /** A WebGL2 context the browser took back. The canvas is spoken for: no 2D on it either. */
  readonly lost: boolean;
}

export function pickBackend(input: BackendInput): EffectBackend {
  const frame: EffectBackend = input.css ? 'css' : 'static';
  if (!input.motion) return 'static';
  if (!input.hydrated || input.wants === 'css') return frame;
  if (input.lost) return frame;
  if (input.wants === 'webgl2' && input.webgl2) return 'webgl2';
  if (input.canvas) return 'canvas';
  return frame;
}
