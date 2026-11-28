// The instrument-panel ground: ui's `grid-texture` with an accent glow drifting across it, in CSS
// alone. Both are withdrawn under `prefers-contrast: more` and `forced-colors`, where texture
// behind text is noise.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './GridGlow.module.scss';
import { GRID_GLOW_BACKEND, gridGlowView } from './grid-glow-view';

export interface GridGlowProps {
  /** The glow's colour role. Default `'accent'`. */
  role?: ColorRole | undefined;
  /** Glow drift speed multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  /** Horizontal scanlines over the grid. Default false. */
  scanlines?: boolean | undefined;
  /** The drifting glow. Default true; false leaves the still grid. */
  glow?: boolean | undefined;
  /** What the grid sits behind. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function GridGlow(props: GridGlowProps): JSX.Element {
  const view = gridGlowView(props);
  return (
    <div
      class={cx(styles['root'], props.class)}
      style={view.vars}
      data-effect-backend={GRID_GLOW_BACKEND}
    >
      <div class={cx(styles['layer'], styles[view.ground])} aria-hidden="true">
        {view.glow ? <span class={styles['glow']} /> : null}
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
