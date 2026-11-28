// GradientOrbs' rules: where each orb sits, how big it is and where in its cycle it starts, from
// the orb's index alone (a golden-angle walk), so the server and an island place them identically.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import { rangeProp, rolesProp } from '../props';

/** The server frame animates in CSS; the island adds the offscreen and hidden-tab pause. */
export const GRADIENT_ORBS_BACKEND: EffectBackend = 'css';

export const GRADIENT_ORBS_ROLES: readonly ColorRole[] = ['accent', 'info', 'chart-3'];

export interface OrbPlacement {
  readonly role: ColorRole;
  /** Centre, percent of the box. */
  readonly x: number;
  readonly y: number;
  /** Diameter, percent of the box's inline size. */
  readonly size: number;
  /** Where in the cycle the orb starts, 0..1. */
  readonly phase: number;
}

const GOLDEN_TURN = 0.381_966;

const round = (value: number): number => Math.round(value * 100) / 100;

export function orbLayout(roles: readonly ColorRole[]): readonly OrbPlacement[] {
  return roles.map((role, index) => {
    const turn = (index * GOLDEN_TURN) % 1;
    const angle = turn * Math.PI * 2;
    const reach = 18 + ((index * 11) % 17);
    return {
      role,
      x: round(50 + Math.cos(angle) * reach),
      y: round(50 + Math.sin(angle) * reach * 0.8),
      size: 34 + ((index * 13) % 22),
      phase: round(turn),
    };
  });
}

export interface GradientOrbsInput {
  readonly roles?: readonly ColorRole[] | undefined;
  readonly speed?: number | undefined;
  readonly intensity?: number | undefined;
}

export interface GradientOrbsView {
  readonly orbs: readonly OrbPlacement[];
  readonly vars: Record<string, string>;
}

export function gradientOrbsView(input: GradientOrbsInput): GradientOrbsView {
  const roles = rolesProp('GradientOrbs', input.roles, GRADIENT_ORBS_ROLES, { min: 1, max: 6 });
  const speed = rangeProp('GradientOrbs', 'speed', input.speed, { min: 0.25, max: 4, fallback: 1 });
  const intensity = rangeProp('GradientOrbs', 'intensity', input.intensity, {
    min: 0,
    max: 1,
    fallback: 0.6,
  });
  return {
    orbs: orbLayout(roles),
    vars: { '--fx-speed': String(speed), '--fx-intensity': String(intensity) },
  };
}

/** One orb's inline custom properties: its role, place, size and phase. */
export function orbVars(orb: OrbPlacement): Record<string, string> {
  return {
    '--fx-c': `var(--color-${orb.role})`,
    '--fx-x': `${orb.x}%`,
    '--fx-y': `${orb.y}%`,
    '--fx-size': `${orb.size}%`,
    '--fx-phase': String(orb.phase),
  };
}
