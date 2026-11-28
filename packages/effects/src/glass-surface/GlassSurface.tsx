// A translucent pane over whatever is behind it, with the palette's text contrast kept (the alpha
// has a measured floor) and an opaque fill under `prefers-reduced-transparency`.

import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './GlassSurface.module.scss';
import { GLASS_BACKEND, GLASS_BLUR_PX, glassAlpha } from './glass-surface-view';

export interface GlassSurfaceProps {
  /** Pane opacity 0-1; never below the contrast-measured floor. */
  alpha?: number | undefined;
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function GlassSurface(props: GlassSurfaceProps): JSX.Element {
  return (
    <div
      class={cx(styles['glass'], props.class)}
      data-effect-backend={GLASS_BACKEND}
      style={{
        '--glass-alpha': String(glassAlpha(props.alpha)),
        '--glass-blur': `${GLASS_BLUR_PX}px`,
      }}
    >
      {props.children}
    </div>
  );
}
