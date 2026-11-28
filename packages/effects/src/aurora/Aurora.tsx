// Northern-lights bands behind a hero, in CSS alone: three role-coloured radial gradients drifting
// on transform. 0 B of JavaScript on a `site/` page; under reduced motion the global rule stills
// the drift and the bands' base position (frame 0) is what remains.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './Aurora.module.scss';
import { AURORA_BACKEND, auroraVars } from './aurora-view';

export interface AuroraProps {
  /** Exactly three colour roles, one per band. Default `['accent', 'info', 'success']`. */
  roles?: readonly ColorRole[] | undefined;
  /** Band opacity, 0..1. Default 0.5. */
  intensity?: number | undefined;
  /** Drift speed multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  /** What the aurora sits behind. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function Aurora(props: AuroraProps): JSX.Element {
  const vars = auroraVars(props);
  return (
    <div class={cx(styles['root'], props.class)} style={vars} data-effect-backend={AURORA_BACKEND}>
      <div class={styles['layer']} aria-hidden="true">
        <span class={cx(styles['band'], styles['band-0'])} />
        <span class={cx(styles['band'], styles['band-1'])} />
        <span class={cx(styles['band'], styles['band-2'])} />
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
