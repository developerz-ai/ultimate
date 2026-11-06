// One series as a single line with no axes — the trend beside a figure, in a table cell, on a
// StatTile. Static SVG for `BarChart`'s reason: the framework's own docs use a sparkline pulling
// in a chart library as the cautionary example, and this file IS that sparkline written the way
// the docs say to. Signed through zero; the path and the area come from `sparkline-view.ts`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Sparkline.module.scss';
import {
  SPARKLINE,
  type SparklinePoint,
  sparkAreaPath,
  sparklinePath,
  sparkPoints,
} from './sparkline-view';
import type { Tone } from './variants';

export interface SparklineProps {
  /** The accessible name for the whole chart, already translated. */
  label: string;
  /** Oldest first. `value: null` is unknown — a gap in the line, never a zero. */
  points: readonly SparklinePoint[];
  /** The line's colour role, in place of `accent`. */
  tone?: Tone | undefined;
  /** Fill under the line, down to zero — above it for a gain, below it for a loss. */
  area?: boolean | undefined;
  class?: string | undefined;
}

export function Sparkline(props: SparklineProps): JSX.Element {
  // The newest point is marked only when it is known: an unknown "now" has no place to sit.
  const last = (): SparklinePoint | undefined => {
    const newest = props.points.at(-1);
    return newest?.value === null ? undefined : newest;
  };
  const lastPoint = () => sparkPoints(props.points).at(-1) ?? undefined;
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${SPARKLINE.width} ${SPARKLINE.height}`}
      class={cx(styles['sparkline'], styles[`tone-${props.tone ?? 'accent'}`], props.class)}
    >
      {props.area === true ? (
        <path class={styles['area']} d={sparkAreaPath(props.points)} data-area="true" />
      ) : null}
      <path class={styles['line']} d={sparklinePath(props.points)} fill="none" />
      {last() === undefined ? null : (
        <circle class={styles['last']} cx={lastPoint()?.x} cy={lastPoint()?.y} r={2}>
          <title>
            {last()?.key}: {last()?.value}
          </title>
        </circle>
      )}
    </svg>
  );
}
