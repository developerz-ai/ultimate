// GridGlow's rules: which grid ground the sheet draws (ui's `grid-texture`, with or without
// scanlines) and the glow's colour role and speed as custom properties.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import { rangeProp, rolesProp, roleVars } from '../props';

/** CSS all the way: the glow drifts in the stylesheet and nothing mounts in an island. */
export const GRID_GLOW_BACKEND: EffectBackend = 'css';

export const GRID_GLOW_ROLES: readonly ColorRole[] = ['accent'];

export interface GridGlowInput {
  readonly role?: ColorRole | undefined;
  readonly speed?: number | undefined;
  readonly scanlines?: boolean | undefined;
  readonly glow?: boolean | undefined;
}

export interface GridGlowView {
  readonly vars: Record<string, string>;
  /** The sheet's class for the ground: `grid` or `grid-scanlines`. */
  readonly ground: 'grid' | 'grid-scanlines';
  readonly glow: boolean;
}

export function gridGlowView(input: GridGlowInput): GridGlowView {
  const roles = rolesProp(
    'GridGlow',
    input.role === undefined ? undefined : [input.role],
    GRID_GLOW_ROLES,
    { min: 1, max: 1 },
  );
  const speed = rangeProp('GridGlow', 'speed', input.speed, { min: 0.25, max: 4, fallback: 1 });
  return {
    vars: { ...roleVars(roles), '--fx-speed': String(speed) },
    ground: input.scanlines === true ? 'grid-scanlines' : 'grid',
    glow: input.glow !== false,
  };
}
