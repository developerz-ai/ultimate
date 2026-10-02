// A bar chart of one series — clicks per day, signups per week — or two stacked (done, and failed
// on top), as static SVG. No charting
// library: the framework's own docs use a sparkline pulling one in as the cautionary example, and
// a route's JS budget counts raw minified bytes. `<rect>` bars cost nothing to hydrate, so the
// server-rendered shell IS the chart. Geometry lives in `bar-chart-view.ts`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './BarChart.module.scss';
import type { ChartPoint } from './bar-chart-view';
import { BAR_CHART, barRects, GRID_STEPS, gridY, maxOf, secondaryRects } from './bar-chart-view';

export interface BarChartProps {
  /** The accessible name for the whole chart, already translated. */
  label: string;
  /** Oldest first. Every bar comes from exactly this array — the caller zero-fills gaps. */
  points: readonly ChartPoint[];
  /** Draw the last bar at full strength — the eye lands where the live number is. Default on. */
  highlightLast?: boolean | undefined;
  /**
   * Names of the two series, already translated, read by each rect's `<title>`. Give them when a
   * point carries `secondary`: a stacked bar with no name for its top is two numbers and no key.
   */
  seriesLabels?: { readonly primary: string; readonly secondary: string } | undefined;
  class?: string | undefined;
}

export function BarChart(props: BarChartProps): JSX.Element {
  const rects = (): readonly ReturnType<typeof barRects>[number][] => barRects(props.points);
  const tops = (): ReturnType<typeof secondaryRects> => secondaryRects(props.points);
  const named = (label: string | undefined, value: number): string =>
    label === undefined ? String(value) : `${label} ${value}`;
  const lastIndex = (): number => props.points.length - 1;
  const first = (): ChartPoint | undefined => props.points[0];
  const last = (): ChartPoint | undefined => props.points.at(-1);
  const highlight = (): boolean => props.highlightLast !== false;
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${BAR_CHART.width} ${BAR_CHART.height}`}
      class={cx(styles['chart'], props.class)}
    >
      {GRID_STEPS.map((step) => (
        <line
          class={styles['grid']}
          x1={0}
          x2={BAR_CHART.width}
          y1={gridY(step)}
          y2={gridY(step)}
        />
      ))}
      {props.points.map((point, index) => {
        const rect = rects()[index];
        if (rect === undefined) return null;
        const top = tops()[index] ?? null;
        return (
          <g>
            <rect
              class={cx(styles['bar'], highlight() && index === lastIndex() && styles['last'])}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx={2}
              data-bar="true"
            >
              <title>{`${point.key}: ${named(props.seriesLabels?.primary, point.value)}`}</title>
            </rect>
            {top === null ? null : (
              <rect
                class={cx(
                  styles['secondary'],
                  highlight() && index === lastIndex() && styles['last'],
                )}
                x={top.x}
                y={top.y}
                width={top.width}
                height={top.height}
                rx={2}
                data-series="secondary"
              >
                <title>{`${point.key}: ${named(props.seriesLabels?.secondary, point.secondary ?? 0)}`}</title>
              </rect>
            )}
          </g>
        );
      })}
      <text class={styles['axis']} x={BAR_CHART.width} y={BAR_CHART.top - 3} text-anchor="end">
        {maxOf(props.points)}
      </text>
      {first() === undefined ? null : (
        <text class={styles['axis']} x={0} y={BAR_CHART.height - 3} text-anchor="start">
          {first()?.key}
        </text>
      )}
      {last() === undefined ? null : (
        <text class={styles['axis']} x={BAR_CHART.width} y={BAR_CHART.height - 3} text-anchor="end">
          {last()?.key}
        </text>
      )}
    </svg>
  );
}
