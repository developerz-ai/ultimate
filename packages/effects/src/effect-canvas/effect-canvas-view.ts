// EffectCanvas's rules: an app's own drawing becomes the same `EffectSpec` every built-in entry
// mounts — the richest backend it supplied, its roles screened, its speed in range.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import type { CanvasDraw } from '../canvas-mount';
import type { EffectSpec } from '../effect-mount';
import type { Rgb } from '../palette';
import { rangeProp, rolesProp } from '../props';
import type { ShaderProgram } from '../shader-mount';

/** The server renders the app's `fallback`: a still frame until an island draws. */
export const EFFECT_CANVAS_BACKEND: EffectBackend = 'static';

export interface EffectCanvasInput {
  readonly draw?: ((colours: () => readonly Rgb[]) => CanvasDraw) | undefined;
  readonly shader?: ((colours: () => readonly Rgb[]) => Promise<ShaderProgram>) | undefined;
  readonly roles?: readonly ColorRole[] | undefined;
  readonly speed?: number | undefined;
}

export function effectCanvasSpec(input: EffectCanvasInput): EffectSpec {
  return {
    css: false,
    wants: input.shader === undefined ? 'canvas' : 'webgl2',
    speed: rangeProp('EffectCanvas', 'speed', input.speed, { min: 0.25, max: 4, fallback: 1 }),
    roles: rolesProp('EffectCanvas', input.roles, ['accent'], { min: 1, max: 8 }),
    shader: input.shader,
    draw2d: input.draw,
  };
}
