// ShaderBackground's rules, shared by the server frame, the Canvas2D fallback and the GLSL's
// uniforms: where the mesh's colour points are at time t, the grain gradient's angle, the dot
// grid's pitch. Time 0 of each is what the server paints, so no backend flashes in. No GLSL here.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import { EffectsInvalidValueError } from '../errors';
import { rangeProp, rolesProp, roleVars } from '../props';

export const SHADER_PRESETS = ['mesh', 'grain', 'dots'] as const;
export type ShaderPreset = (typeof SHADER_PRESETS)[number];

/** The server frame is a still picture: frame 0, until an island draws. */
export const SHADER_BACKGROUND_BACKEND: EffectBackend = 'static';

/** `[base, a, b, c]`: the ground, then the colours drawn over it. */
export const SHADER_BACKGROUND_ROLES: readonly ColorRole[] = [
  'bg-soft',
  'accent',
  'info',
  'chart-3',
];

/** A mesh point's reach: its ellipse spans this fraction of each axis (CSS `ellipse 60% 60%`). */
export const MESH_RADIUS = 0.6;
/** A mesh point's peak opacity. */
export const MESH_PEAK = 0.9;
/** The dot grid's pitch and dot radius, in CSS pixels. */
export const DOT_PITCH = 16;
export const DOT_RADIUS = DOT_PITCH * 0.18;

const MESH_PATHS = [
  { ax: 0.31, ay: 0.27, wx: 0.21, wy: 0.17, px: 2.1, py: 0.4 },
  { ax: 0.28, ay: 0.3, wx: 0.15, wy: 0.23, px: 4.4, py: 2.6 },
  { ax: 0.33, ay: 0.25, wx: 0.19, wy: 0.13, px: 0.3, py: 4.9 },
] as const;

/** The mesh's three colour points at `time` seconds, in 0..1 box units (y down, as CSS). */
export function meshPoints(time: number): readonly (readonly [number, number])[] {
  return MESH_PATHS.map((path) => [
    0.5 + path.ax * Math.sin(time * path.wx + path.px),
    0.5 + path.ay * Math.cos(time * path.wy + path.py),
  ]);
}

/** The grain gradient's CSS angle, in degrees, at `time` seconds. */
export function grainAngle(time: number): number {
  return 135 + 20 * Math.sin(time * 0.25);
}

/** 0 at frame 0, 1 after two seconds: how much of the dots' wave and hue drift is shown. */
export function dotsRamp(time: number): number {
  const x = Math.min(1, Math.max(0, time / 2));
  return x * x * (3 - 2 * x);
}

export interface ShaderBackgroundInput {
  readonly preset?: ShaderPreset | undefined;
  readonly roles?: readonly ColorRole[] | undefined;
  readonly speed?: number | undefined;
}

export interface ShaderBackgroundView {
  readonly preset: ShaderPreset;
  readonly roles: readonly ColorRole[];
  readonly speed: number;
  readonly vars: Record<string, string>;
}

const percent = (value: number): string => `${Math.round(value * 10_000) / 100}%`;

export function shaderBackgroundView(input: ShaderBackgroundInput): ShaderBackgroundView {
  const preset = input.preset ?? 'mesh';
  if (!SHADER_PRESETS.includes(preset)) {
    throw new EffectsInvalidValueError({
      cause: `<ShaderBackground preset> is '${String(preset)}', not one of ${SHADER_PRESETS.join(', ')}`,
      fix: `<ShaderBackground preset="mesh" />   // or "grain", "dots"`,
    });
  }
  const roles = rolesProp('ShaderBackground', input.roles, SHADER_BACKGROUND_ROLES, {
    min: 4,
    max: 4,
  });
  const speed = rangeProp('ShaderBackground', 'speed', input.speed, {
    min: 0.25,
    max: 4,
    fallback: 1,
  });
  const vars: Record<string, string> = { ...roleVars(roles) };
  meshPoints(0).forEach(([x, y], index) => {
    vars[`--fx-p${index}x`] = percent(x);
    vars[`--fx-p${index}y`] = percent(y);
  });
  vars['--fx-angle'] = `${grainAngle(0)}deg`;
  vars['--fx-pitch'] = `${DOT_PITCH}px`;
  vars['--fx-dot'] = `${DOT_RADIUS}px`;
  return { preset, roles, speed, vars };
}
