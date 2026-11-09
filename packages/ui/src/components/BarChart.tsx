// A bar chart of one series — clicks per day, signups per week — two stacked (done, and failed on
// top), or n side by side over shared keys: SVG bars, HTML axis labels. Signed: a loss hangs below
// a drawn zero line, a gap is no bar. No charting library: `<rect>` bars cost nothing to hydrate,
// so the server-rendered shell IS the chart. It stands in a `ChartFrame`: legend, hidden table.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import styles from './BarChart.module.scss';
import type { BarExtent, BarRect, ChartPoint } from './bar-chart-view';
import {
  BAR_CHART,
  barExtent,
  barRects,
  GRID_STEPS,
  gridY,
  groupedBarRects,
  secondaryRects,
  seriesExtent,
  valueY,
  zeroY,
} from './bar-chart-view';
import type { ChartHit, ChartLegendItem } from './ChartFrame';
import { ChartFrame, ChartHits, ReferenceLabels, ReferenceRules } from './ChartFrame';
import { checkSeries } from './chart-checks';
import type { ChartSeries } from './chart-frame-view';
import {
  chartNumberFormat,
  chartTable,
  cssPercent,
  hitEdge,
  hitIds,
  pointLabel,
  seriesStyle,
} from './chart-frame-view';
import type { ChartReference } from './chart-reference-view';
import { referenceLines, referenceValues } from './chart-reference-view';
import type { Tone } from './variants';

interface BarChartBase {
  /** The accessible name for the whole chart, already translated. */
  label: string;
  /** Draw the last bar at full strength — the eye lands where the live number is. Default on. */
  highlightLast?: boolean | undefined;
  /** The key column's head in the data table, already translated — "Day". */
  keyLabel?: string | undefined;
  /** Formats every value. Default: `Intl.NumberFormat` in the page's locale. */
  format?: ((value: number) => string) | undefined;
  /** Dashed rules at a value — a target, a limit. Each widens the range so it stays on the plot. */
  references?: readonly ChartReference[] | undefined;
  /** Give every bar a tab stop and a hover/focus/tap readout. Default off: no tab stops. */
  focusable?: boolean | undefined;
  /** Show the caption above the plot. Default off — it names the figure either way. */
  showCaption?: boolean | undefined;
  /** Lands on the root `<figure>`, which holds the svg and its HTML axis labels. */
  class?: string | undefined;
}

/** One series, or two stacked: a point per bar. */
export interface BarChartPointsProps extends BarChartBase {
  /** Oldest first. `value: null` is unknown — no bar, and the table says so. Never zero-fill. */
  points: readonly ChartPoint[];
  /** Names of the two series, already translated, when a point carries `secondary`. */
  seriesLabels?: { readonly primary: string; readonly secondary: string } | undefined;
  /** The primary bars' colour role, in place of `accent` — a failure count in `danger`. */
  tone?: Tone | undefined;
  keys?: undefined;
  series?: undefined;
}

/** n series side by side over shared keys; each series' `tone` overrides its slot colour. */
export interface BarChartSeriesProps extends BarChartBase {
  keys: readonly string[];
  /** `values[i]` belongs to `keys[i]`, exactly one per key — `null` for a gap. */
  series: readonly ChartSeries[];
  points?: undefined;
  seriesLabels?: undefined;
  tone?: undefined;
}

export type BarChartProps = BarChartPointsProps | BarChartSeriesProps;

interface BarMark {
  readonly rect: BarRect;
  readonly key: string;
  readonly name: string | undefined;
  readonly value: number;
  readonly series: number;
  readonly id: string;
  readonly last: boolean;
}

export function BarChart(props: BarChartProps): JSX.Element {
  const ui = useUi();
  const format = (value: number): string => (props.format ?? chartNumberFormat(ui.locale))(value);
  const keys = (): readonly string[] =>
    props.series === undefined ? props.points.map((p) => p.key) : props.keys;
  const series = (): readonly ChartSeries[] => {
    if (props.series !== undefined) {
      checkSeries('BarChart', props.keys, props.series);
      return props.series;
    }
    const points = props.points;
    const stacked = points.some((point) => (point.secondary ?? 0) > 0);
    const primary = {
      label: props.seriesLabels?.primary ?? props.label,
      values: points.map((p) => p.value),
    };
    return props.seriesLabels === undefined && !stacked
      ? [primary]
      : [
          primary,
          {
            label: props.seriesLabels?.secondary ?? '',
            values: points.map((p) => p.secondary ?? 0),
          },
        ];
  };
  const extent = (): BarExtent => {
    const also = referenceValues(props.references);
    return props.series === undefined
      ? barExtent(props.points, also)
      : seriesExtent(props.series, also);
  };
  const highlight = (index: number): boolean =>
    props.highlightLast !== false && index === keys().length - 1;

  /** Every drawn bar, in reading order: key by key, series by series. */
  const marks = (): readonly BarMark[] => {
    const scale = extent();
    if (props.series !== undefined) {
      const grid = groupedBarRects(props.keys.length, series(), scale);
      return props.keys.flatMap((key, k) =>
        series().flatMap((one, s): BarMark[] => {
          const rect = grid[s]?.[k] ?? null;
          const value = one.values[k] ?? null;
          if (rect === null || value === null) return [];
          const id = hitIds(s, props.keys)[k] ?? `${s}:${k}`;
          return [{ rect, key, name: one.label, value, series: s, id, last: highlight(k) }];
        }),
      );
    }
    const points = props.points;
    const ids = (s: number) =>
      hitIds(
        s,
        points.map((p) => p.key),
      );
    const lower = barRects(points, scale);
    const upper = secondaryRects(points, scale);
    return points.flatMap((point, k): BarMark[] => {
      const out: BarMark[] = [];
      const base = lower[k] ?? null;
      if (base !== null && point.value !== null) {
        out.push({
          rect: base,
          key: point.key,
          name: props.seriesLabels?.primary,
          value: point.value,
          series: 0,
          id: ids(0)[k] ?? '',
          last: highlight(k),
        });
      }
      const top = upper[k] ?? null;
      if (top !== null) {
        out.push({
          rect: top,
          key: point.key,
          name: props.seriesLabels?.secondary,
          value: point.secondary ?? 0,
          series: 1,
          id: ids(1)[k] ?? '',
          last: highlight(k),
        });
      }
      return out;
    });
  };

  const legend = (): readonly ChartLegendItem[] | undefined => {
    if (props.series !== undefined) {
      return props.series.length < 2
        ? undefined
        : props.series.map((one, s) => ({
            label: one.label,
            swatch: (
              <span
                class={styles['swatch']}
                data-series={seriesStyle(s).slot}
                data-tone={one.tone}
              />
            ),
          }));
    }
    return props.seriesLabels === undefined
      ? undefined
      : [
          {
            label: props.seriesLabels.primary,
            swatch: <span class={styles['swatch']} data-tone={props.tone} />,
          },
          {
            label: props.seriesLabels.secondary,
            swatch: <span class={cx(styles['swatch'], styles['swatchSecondary'])} />,
          },
        ];
  };

  const hits = (): readonly ChartHit[] =>
    marks().map((mark) => {
      const x = mark.rect.x + mark.rect.width / 2;
      return {
        id: mark.id,
        x: cssPercent(x, BAR_CHART.width),
        y: cssPercent(
          mark.value < 0 ? mark.rect.y + mark.rect.height : mark.rect.y,
          BAR_CHART.height,
        ),
        label: pointLabel(mark.key, mark.name, format(mark.value)),
        edge: hitEdge(x, BAR_CHART.width),
      };
    });

  const lines = () => referenceLines(props.references, (value) => valueY(value, extent()));

  const rectOf = (mark: BarMark): JSX.Element => {
    const secondary = props.series === undefined && mark.series === 1;
    return (
      <rect
        class={cx(secondary ? styles['secondary'] : styles['bar'], mark.last && styles['last'])}
        x={mark.rect.x}
        y={mark.rect.y}
        width={mark.rect.width}
        height={mark.rect.height}
        rx={2}
        data-bar={secondary ? undefined : 'true'}
        data-series={
          secondary
            ? 'secondary'
            : props.series === undefined
              ? undefined
              : seriesStyle(mark.series).slot
        }
        data-tone={
          props.series === undefined
            ? secondary
              ? undefined
              : props.tone
            : props.series[mark.series]?.tone
        }
        data-sign={mark.value < 0 ? 'negative' : undefined}
      >
        <title>{`${mark.key}: ${mark.name === undefined ? format(mark.value) : `${mark.name} ${format(mark.value)}`}`}</title>
      </rect>
    );
  };

  return (
    <ChartFrame
      label={props.label}
      showCaption={props.showCaption}
      class={props.class}
      legend={legend()}
      table={chartTable({
        caption: props.label,
        keyLabel: props.keyLabel,
        keys: keys(),
        series: series(),
        format,
        none: ui.t(UI_KEYS.chartNone),
      })}
    >
      <div class={styles['chart']}>
        {/* aria-hidden: the svg is the image and names itself; a bare "9" read aloud is noise. */}
        <span class={cx(styles['axis'], styles['max'])} data-axis="max" aria-hidden="true">
          {format(extent().max)}
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
            {extent().min < 0 ? (
              <line
                class={styles['zero']}
                data-zero="true"
                x1={0}
                x2={BAR_CHART.width}
                y1={zeroY(extent())}
                y2={zeroY(extent())}
              />
            ) : null}
            {marks().map(rectOf)}
            <ReferenceRules lines={lines()} width={BAR_CHART.width} />
          </svg>
          <ReferenceLabels lines={lines()} height={BAR_CHART.height} format={format} />
          {props.focusable === true ? <ChartHits hits={hits()} /> : null}
        </div>
        {extent().min < 0 ? (
          <span class={cx(styles['axis'], styles['max'])} data-axis="min" aria-hidden="true">
            {format(extent().min)}
          </span>
        ) : null}
        {keys().length === 0 ? null : (
          <div class={styles['keys']} aria-hidden="true">
            <span class={styles['axis']} data-axis="first">
              {keys()[0]}
            </span>
            {/* One point: its bar is both first and last, so its key is named once. */}
            {keys().length === 1 ? null : (
              <span class={styles['axis']} data-axis="last">
                {keys().at(-1)}
              </span>
            )}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
