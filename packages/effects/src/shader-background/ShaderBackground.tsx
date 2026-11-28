// A GPU background behind a hero: `mesh`, `grain` or `dots`, our own GLSL on our own WebGL2 mount.
// The server paints frame 0 in CSS (no script, no flash); an island fetches only its preset's
// chunk, draws on WebGL2 or else Canvas2D, and falls back to that frame under reduced motion.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Noise } from '../noise/Noise';
import { loadShader } from '../shader-load';
import { useEffectMount } from '../use-effect-mount';
import { loadPreset } from './load-preset';
import styles from './ShaderBackground.module.scss';
import { presetCanvas } from './shader-background-canvas';
import {
  SHADER_BACKGROUND_BACKEND,
  type ShaderPreset,
  shaderBackgroundView,
} from './shader-background-view';

export interface ShaderBackgroundProps {
  /** Which shader. Default `'mesh'`. */
  preset?: ShaderPreset | undefined;
  /** `[ground, a, b, c]`: four colour roles. Default `['bg-soft', 'accent', 'info', 'chart-3']`. */
  roles?: readonly ColorRole[] | undefined;
  /** Animation speed multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  /** What the background sits behind. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function ShaderBackground(props: ShaderBackgroundProps): JSX.Element {
  const view = shaderBackgroundView(props);
  const fx = useEffectMount(
    {
      css: false,
      wants: 'webgl2',
      speed: view.speed,
      roles: view.roles,
      shader: (colours) => loadShader(loadPreset(view.preset).then((program) => program(colours))),
      draw2d: (colours) => presetCanvas(view.preset, colours),
    },
    SHADER_BACKGROUND_BACKEND,
  );
  return (
    <div
      ref={fx.root}
      class={cx(styles['root'], props.class)}
      style={view.vars}
      data-effect-backend={fx.backend()}
    >
      <div class={styles['layer']} aria-hidden="true">
        <div class={cx(styles['frame'], styles[view.preset])} />
        <canvas ref={fx.canvas} class={styles['canvas']} />
        {view.preset === 'grain' ? <Noise class={styles['grain-overlay']} opacity={0.18} /> : null}
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
