// Aurora's rules: the validated props as the custom properties its stylesheet animates. Pure, so
// the server frame and every test read the same numbers; the sheet does the motion.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import { rangeProp, rolesProp, roleVars } from '../props';

/** CSS all the way: the server frame animates in CSS and nothing mounts in an island. */
export const AURORA_BACKEND: EffectBackend = 'css';

export const AURORA_ROLES: readonly ColorRole[] = ['accent', 'info', 'success'];
export const AURORA_BANDS = 3;

export interface AuroraInput {
  readonly roles?: readonly ColorRole[] | undefined;
  readonly intensity?: number | undefined;
  readonly speed?: number | undefined;
}

export function auroraVars(input: AuroraInput): Record<string, string> {
  const roles = rolesProp('Aurora', input.roles, AURORA_ROLES, {
    min: AURORA_BANDS,
    max: AURORA_BANDS,
  });
  const intensity = rangeProp('Aurora', 'intensity', input.intensity, {
    min: 0,
    max: 1,
    fallback: 0.5,
  });
  const speed = rangeProp('Aurora', 'speed', input.speed, { min: 0.25, max: 4, fallback: 1 });
  return { ...roleVars(roles), '--fx-intensity': String(intensity), '--fx-speed': String(speed) };
}
