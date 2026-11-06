// One labelled figure with an optional trend chip, a sparkline and a line of context — the tile a
// dashboard's top row is made of. The figure arrives formatted (the caller's `Intl.NumberFormat`),
// and whether up is good is the caller's one prop (`goodWhen`): the arrow always shows the way,
// the colour only what the caller said it means.
//
// Intrinsic tags only: a runtime-chosen root (`const Tag = props.as ?? 'div'`) is called as a
// component by the island build, so a linked tile is a second literal `<a>`, never a variable tag.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { Skeleton } from './Skeleton';
import { Sparkline } from './Sparkline';
import styles from './StatTile.module.scss';
import type { SparklinePoint } from './sparkline-view';
import type { StatDelta, StatGoodWhen } from './stat-delta';
import { DELTA_ARROW_PATH, deltaMood } from './stat-delta';
import type { Tone } from './variants';

export interface StatTileProps {
  /** The tile's caption, already translated — "Total links", "Clicks today". */
  label: string;
  /** The figure, already formatted as the string this tile shows. */
  value: string;
  /** The stable hook a test or a live check reads the figure through: `data-stat`. */
  stat: string;
  /** The trend chip; `deltaOf()` builds one from a current and a baseline. */
  delta?: StatDelta | undefined;
  /** Which direction of `delta` is good news. Default `'up'`; `'none'` colours neither. */
  goodWhen?: StatGoodWhen | undefined;
  /** The denominator, formatted — "of 40" reads after the figure: "12 of 40". */
  of?: string | undefined;
  /** The recent series behind the figure, oldest first; `null` is a gap. */
  trend?: readonly SparklinePoint[] | undefined;
  /** A status edge on the tile — `danger` for a figure past its limit. */
  tone?: Tone | undefined;
  /** The page behind the figure: the whole tile becomes one link. */
  href?: string | undefined;
  /** The figure is on its way: a skeleton in its box, so the row does not shift when it lands. */
  loading?: boolean | undefined;
  /** One short line of context under the figure: "vs yesterday", "849 clicks". */
  hint?: string | undefined;
  class?: string | undefined;
}

export function StatTile(props: StatTileProps): JSX.Element {
  const classes = (): string =>
    cx(
      styles['tile'],
      props.tone !== undefined && [styles['toned'], styles[`tone-${props.tone}`]],
      props.href !== undefined && styles['linked'],
      props.class,
    );
  const body = (): JSX.Element => (
    <>
      <p class={styles['label']}>{props.label}</p>
      <div class={styles['figure']} aria-busy={props.loading === true ? 'true' : undefined}>
        {props.loading === true ? (
          <span class={styles['value']}>
            <Skeleton width="6ch" height="1em" />
          </span>
        ) : (
          <p class={styles['value']} data-stat={props.stat}>
            {props.value}
          </p>
        )}
        {/* Beside the figure, not in it: `data-stat` reads the number alone. */}
        {props.of === undefined ? null : <span class={styles['of']}>{props.of}</span>}
        {props.delta === undefined || props.loading === true ? null : (
          <span
            class={cx(
              styles['delta'],
              styles[`mood-${deltaMood(props.delta.trend, props.goodWhen ?? 'up')}`],
            )}
            data-trend={props.delta.trend}
            data-mood={deltaMood(props.delta.trend, props.goodWhen ?? 'up')}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true" class={styles['arrow']}>
              <path d={DELTA_ARROW_PATH[props.delta.trend]} />
            </svg>
            {props.delta.text}
          </span>
        )}
      </div>
      {props.trend === undefined ? null : (
        <Sparkline
          label={props.label}
          points={props.trend}
          tone={props.tone}
          class={styles['trend']}
        />
      )}
      {props.hint === undefined ? null : <p class={styles['hint']}>{props.hint}</p>}
    </>
  );
  // The branch inside the JSX: in an island the body runs once, and a branch decided there would
  // keep the first answer for the island's life.
  return (
    <>
      {props.href === undefined ? (
        <div class={classes()}>{body()}</div>
      ) : (
        <a class={classes()} href={props.href}>
          {body()}
        </a>
      )}
    </>
  );
}
