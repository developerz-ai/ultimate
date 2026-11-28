// Soft role-coloured orbs drifting behind a surface, moved on transform and opacity only. The
// server frame floats in CSS; in an island the drift also holds offscreen and in a hidden tab.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useCssPause } from '../use-css-pause';
import styles from './GradientOrbs.module.scss';
import { GRADIENT_ORBS_BACKEND, gradientOrbsView, orbVars } from './gradient-orbs-view';

export interface GradientOrbsProps {
  /** One orb per role, 1..6. Default `['accent', 'info', 'chart-3']`. */
  roles?: readonly ColorRole[] | undefined;
  /** Drift speed multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  /** Orb opacity, 0..1. Default 0.6. */
  intensity?: number | undefined;
  /** What the orbs sit behind. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function GradientOrbs(props: GradientOrbsProps): JSX.Element {
  const view = gradientOrbsView(props);
  const fx = useCssPause(GRADIENT_ORBS_BACKEND);
  return (
    <div
      ref={fx.root}
      class={cx(styles['root'], props.class)}
      style={view.vars}
      data-effect-backend={fx.backend()}
    >
      <div class={styles['layer']} aria-hidden="true">
        {view.orbs.map((orb) => (
          <span class={styles['orb']} style={orbVars(orb)} />
        ))}
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
