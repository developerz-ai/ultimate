// A holographic tile wall: tiles shifting between two colour roles. The server renders frame 0 as
// real tiles (no blank canvas, no script needed); an island redraws the same function on a
// Canvas2D that `frameLoop` pauses offscreen, in a hidden tab and under reduced motion.

import type { ColorRole } from '@ultimat3/ui';
import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useEffectMount } from '../use-effect-mount';
import styles from './MosaicGrid.module.scss';
import { drawMosaic, MOSAIC_GRID_BACKEND, mosaicGridView } from './mosaic-grid-view';

export interface MosaicGridProps {
  /** Tiles across, 4..32. Default 16. */
  cols?: number | undefined;
  /** Tiles down, 3..20. Default 9. */
  rows?: number | undefined;
  /** The two colour roles tiles shift between. Default `['accent', 'info']`. */
  roles?: readonly ColorRole[] | undefined;
  /** Shift speed multiplier, 0.25..4. Default 1. */
  speed?: number | undefined;
  /** What the mosaic sits behind. */
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function MosaicGrid(props: MosaicGridProps): JSX.Element {
  const view = mosaicGridView(props);
  const fx = useEffectMount(
    {
      css: false,
      wants: 'canvas',
      speed: view.speed,
      roles: view.roles,
      draw2d: (colours) => drawMosaic(view.cols, view.rows, colours),
    },
    MOSAIC_GRID_BACKEND,
  );
  return (
    <div
      ref={fx.root}
      class={cx(styles['root'], props.class)}
      style={view.vars}
      data-effect-backend={fx.backend()}
    >
      <div class={styles['layer']} aria-hidden="true">
        <div class={styles['tiles']}>
          {view.cells.map((cell) => (
            <span
              class={styles['tile']}
              style={{ '--fx-a': String(cell.alpha), '--fx-m': String(cell.mix) }}
            />
          ))}
        </div>
        <canvas ref={fx.canvas} class={styles['canvas']} />
      </div>
      <div class={styles['content']}>{props.children}</div>
    </div>
  );
}
