// One series as a single line with no axes — the trend beside a figure, in a table cell, on a
// detail page. Static SVG for `BarChart`'s reason: the framework's own docs use a sparkline
// pulling in a chart library as the cautionary example, and this file IS that sparkline written
// the way the docs say to. The path comes from `sparkline-view.ts`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import type { ChartPoint } from './bar-chart-view';
import styles from './Sparkline.module.scss';
import { SPARKLINE, sparklinePath, sparkPoints } from './sparkline-view';

export interface SparklineProps {
  /** The accessible name for the whole chart, already translated. */
  label: string;
  /** Oldest first. Every point comes from exactly this array — the caller zero-fills gaps. */
  points: readonly ChartPoint[];
  class?: string | undefined;
}

export function Sparkline(props: SparklineProps): JSX.Element {
  const last = (): ChartPoint | undefined => props.points.at(-1);
  const lastPoint = () => sparkPoints(props.points).at(-1);
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${SPARKLINE.width} ${SPARKLINE.height}`}
      class={cx(styles['sparkline'], props.class)}
    >
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
