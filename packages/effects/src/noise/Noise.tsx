// Film grain over a surface: an SVG turbulence filter tinted with a colour role. Static by nature
// (no animation, no frame loop, no script), so it costs a `site/` page nothing and has no motion
// for reduced motion to take away.

import type { ColorRole } from '@ultimat3/ui';
import { cx, useId } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './Noise.module.scss';
import { NOISE_ALPHA_MATRIX, NOISE_BACKEND, NOISE_TURBULENCE, noiseView } from './noise-view';

export interface NoiseProps {
  /** Grain opacity, 0..1. Default 0.12. */
  opacity?: number | undefined;
  /** The grain's colour role. Default `'fg'`. */
  role?: ColorRole | undefined;
  /** What the grain lies over. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function Noise(props: NoiseProps): JSX.Element {
  const view = noiseView(props);
  const filter = useId('fx-noise');
  return (
    <div
      class={cx(styles['root'], props.class)}
      style={view.vars}
      data-effect-backend={NOISE_BACKEND}
    >
      <svg class={styles['layer']} aria-hidden="true">
        <filter id={filter}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency={NOISE_TURBULENCE.baseFrequency}
            numOctaves={NOISE_TURBULENCE.numOctaves}
            seed={NOISE_TURBULENCE.seed}
            stitchTiles="stitch"
            result="turbulence"
          />
          <feColorMatrix in="turbulence" type="matrix" values={NOISE_ALPHA_MATRIX} result="grain" />
          <feFlood flood-color="currentColor" result="tint" />
          <feComposite in="tint" in2="grain" operator="in" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filter})`} />
      </svg>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
