// A bar chart of one series — clicks per day, signups per week — or two stacked (done, and failed
// on top): SVG bars, HTML axis labels. No charting library: the framework's own docs use a
// sparkline pulling one in as the cautionary example, and a route's JS budget counts raw minified
// bytes. `<rect>` bars cost nothing to hydrate, so the server-rendered shell IS the chart. The
// labels sit outside the svg because text inside a viewBox scales with it — a speck at phone width.
// It stands in a `ChartFrame`: a legend for two series, and a hidden table of the same numbers.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import styles from './BarChart.module.scss';
import type { ChartPoint } from './bar-chart-view';
import { BAR_CHART, barRects, GRID_STEPS, gridY, maxOf, secondaryRects } from './bar-chart-view';
import type { ChartHit, ChartLegendItem } from './ChartFrame';
import { ChartFrame, chartHits } from './ChartFrame';
import type { ChartSeries } from './chart-frame-view';
import { chartNumberFormat, chartTable, cssPercent, hitEdge, pointLabel } from './chart-frame-view';

export interface BarChartProps {
  /** The accessible name for the whole chart, already translated. */
  label: string;
  /** Oldest first. Every bar comes from exactly this array — the caller zero-fills gaps. */
  points: readonly ChartPoint[];
  /** Draw the last bar at full strength — the eye lands where the live number is. Default on. */
  highlightLast?: boolean | undefined;
  /**
   * Names of the two series, already translated, read by each rect's `<title>`, the legend and
   * the data table. Give them when a point carries `secondary`: a stacked bar with no name for its
   * top is two numbers and no key.
   */
  seriesLabels?: { readonly primary: string; readonly secondary: string } | undefined;
  /** The key column's head in the data table, already translated — "Day". */
  keyLabel?: string | undefined;
  /** Formats every value. Default: `Intl.NumberFormat` in the page's locale. */
  format?: ((value: number) => string) | undefined;
  /** Give every bar a tab stop and a hover/focus readout. Default off: no tab stops. */
  focusable?: boolean | undefined;
  /** Show the caption above the plot. Default off — it names the figure either way. */
  showCaption?: boolean | undefined;
  /** Lands on the root `<figure>`, which holds the svg and its HTML axis labels. */
  class?: string | undefined;
}

export function BarChart(props: BarChartProps): JSX.Element {
  const ui = useUi();
  const format = (value: number): string => (props.format ?? chartNumberFormat(ui.locale))(value);
  const rects = (): readonly ReturnType<typeof barRects>[number][] => barRects(props.points);
  const tops = (): ReturnType<typeof secondaryRects> => secondaryRects(props.points);
  const named = (label: string | undefined, value: number): string =>
    label === undefined ? format(value) : `${label} ${format(value)}`;
  const lastIndex = (): number => props.points.length - 1;
  const highlight = (): boolean => props.highlightLast !== false;
  const stacked = (): boolean => props.points.some((point) => (point.secondary ?? 0) > 0);

  const series = (): readonly ChartSeries[] => [
    { label: props.seriesLabels?.primary ?? props.label, values: props.points.map((p) => p.value) },
    ...(props.seriesLabels !== undefined || stacked()
      ? [
          {
            label: props.seriesLabels?.secondary ?? '',
            values: props.points.map((p) => p.secondary ?? 0),
          },
        ]
      : []),
  ];

  const legend = (): readonly ChartLegendItem[] | undefined =>
    props.seriesLabels === undefined
      ? undefined
      : [
          { label: props.seriesLabels.primary, swatch: <span class={styles['swatch']} /> },
          {
            label: props.seriesLabels.secondary,
            swatch: <span class={cx(styles['swatch'], styles['swatchSecondary'])} />,
          },
        ];

  const hits = (): readonly ChartHit[] =>
    props.points.flatMap((point, index) => {
      const rect = rects()[index];
      if (rect === undefined) return [];
      const top = tops()[index] ?? null;
      const x = rect.x + rect.width / 2;
      const own = (y: number, label: string | undefined, value: number): ChartHit => ({
        x: cssPercent(x, BAR_CHART.width),
        y: cssPercent(y, BAR_CHART.height),
        label: pointLabel(point.key, label, format(value)),
        edge: hitEdge(x, BAR_CHART.width),
      });
      const first = own(rect.y, props.seriesLabels?.primary, point.value);
      return top === null
        ? [first]
        : [first, own(top.y, props.seriesLabels?.secondary, point.secondary ?? 0)];
    });

  return (
    <ChartFrame
      label={props.label}
      showCaption={props.showCaption}
      class={props.class}
      legend={legend()}
      table={chartTable({
        caption: props.label,
        keyLabel: props.keyLabel,
        keys: props.points.map((point) => point.key),
        series: series(),
        format,
      })}
    >
      <div class={styles['chart']}>
        {/* aria-hidden: the svg is the image and names itself; a bare "9" read aloud is noise. */}
        <span class={cx(styles['axis'], styles['max'])} data-axis="max" aria-hidden="true">
          {format(maxOf(props.points))}
        </span>
        <div class={styles['box']}>
          <svg
            role="img"
            aria-label={props.label}
            viewBox={`0 0 ${BAR_CHART.width} ${BAR_CHART.height}`}
            class={styles['plot']}
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
              const last = highlight() && index === lastIndex();
              return (
                <g>
                  <rect
                    class={cx(styles['bar'], last && styles['last'])}
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
                      class={cx(styles['secondary'], last && styles['last'])}
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
          </svg>
          {props.focusable === true ? chartHits(hits()) : null}
        </div>
        {props.points.length === 0 ? null : (
          <div class={styles['keys']} aria-hidden="true">
            <span class={styles['axis']} data-axis="first">
              {props.points[0]?.key}
            </span>
            {/* One point: its bar is both first and last, so its key is named once. */}
            {props.points.length === 1 ? null : (
              <span class={styles['axis']} data-axis="last">
                {props.points.at(-1)?.key}
              </span>
            )}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
