// The escape hatch for an effect the catalogue does not have: an app's own Canvas2D `draw` or
// WebGL2 `shader`, mounted on the same budget, pause and lost-context rules as every built-in.
// `fallback` is REQUIRED by type — it is the server frame, the reduced-motion frame, the no-GPU frame.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { CanvasDraw } from '../canvas-mount';
import type { Rgb } from '../palette';
import type { ShaderProgram } from '../shader-mount';
import { useEffectMount } from '../use-effect-mount';
import styles from './EffectCanvas.module.scss';
import { EFFECT_CANVAS_BACKEND, effectCanvasSpec } from './effect-canvas-view';

interface EffectCanvasBase {
  /** What shows before an island draws, under reduced motion, and with no usable context. */
  fallback: JSX.Element;
  /** Roles resolved to channels for `draw`/`shader`, 1..8. Default `['accent']`. */
  roles?: readonly ColorRole[] | undefined;
  /** Time multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

/** Canvas2D: `draw` builds the per-frame function from the resolved palette. */
export interface EffectCanvasDrawProps extends EffectCanvasBase {
  draw: (colours: () => readonly Rgb[]) => CanvasDraw;
  shader?: ((colours: () => readonly Rgb[]) => Promise<ShaderProgram>) | undefined;
}

/** WebGL2: `shader` loads the program (lazily, so its GLSL is its own chunk); `draw` is the Canvas2D fallback. */
export interface EffectCanvasShaderProps extends EffectCanvasBase {
  shader: (colours: () => readonly Rgb[]) => Promise<ShaderProgram>;
  draw?: ((colours: () => readonly Rgb[]) => CanvasDraw) | undefined;
}

export type EffectCanvasProps = EffectCanvasDrawProps | EffectCanvasShaderProps;

export function EffectCanvas(props: EffectCanvasProps): JSX.Element {
  const fx = useEffectMount(effectCanvasSpec(props), EFFECT_CANVAS_BACKEND);
  return (
    <div ref={fx.root} class={cx(styles['root'], props.class)} data-effect-backend={fx.backend()}>
      <div class={styles['layer']} aria-hidden="true">
        <div class={styles['frame']}>{props.fallback}</div>
        <canvas ref={fx.canvas} class={styles['canvas']} />
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
