// One labelled figure with an optional trend chip and a line of context — the tile a dashboard's
// top row is made of. The figure arrives formatted: number formatting is the caller's
// (`Intl.NumberFormat` against the page locale), so the tile never guesses a locale.
//
// Intrinsic tags only: a runtime-chosen root (`const Tag = props.as ?? 'div'`) is called as a
// component by the island build, so a tile built on `Card` hydrated differently from how it was
// served. A `<div>` renders identically on both sides.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './StatTile.module.scss';
import type { StatDelta } from './stat-delta';
import { DELTA_ARROW_PATH } from './stat-delta';

export interface StatTileProps {
  /** The tile's caption, already translated — "Total links", "Clicks today". */
  label: string;
  /** The figure, already formatted as the string this tile shows. */
  value: string;
  /** The stable hook a test or a live check reads the figure through: `data-stat`. */
  stat: string;
  /** The trend chip; `deltaOf()` builds one from a current and a baseline. */
  delta?: StatDelta | undefined;
  /** One short line of context under the figure: "vs yesterday", "849 clicks". */
  hint?: string | undefined;
  class?: string | undefined;
}

export function StatTile(props: StatTileProps): JSX.Element {
  return (
    <div class={cx(styles['tile'], props.class)}>
      <p class={styles['label']}>{props.label}</p>
      <div class={styles['figure']}>
        <p class={styles['value']} data-stat={props.stat}>
          {props.value}
        </p>
        {props.delta === undefined ? null : (
          <span class={cx(styles['delta'], styles[`trend-${props.delta.trend}`])}>
            <svg viewBox="0 0 10 10" aria-hidden="true" class={styles['arrow']}>
              <path d={DELTA_ARROW_PATH[props.delta.trend]} />
            </svg>
            {props.delta.text}
          </span>
        )}
      </div>
      {props.hint === undefined ? null : <p class={styles['hint']}>{props.hint}</p>}
    </div>
  );
}
