// A line chart of one or more series over the same keys — signups per day, p95 per hour — and
// `AreaChart`, the same chart with each series' area filled to the baseline. SVG lines on a nice
// 1-2-5 value axis, HTML axis labels (text inside a viewBox scales to a speck on a phone), a
// legend, and a hidden data table. Every series has its own dash and marker, never colour alone.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import type { ChartHit } from './ChartFrame';
import { ChartFrame, chartHits, seriesSwatch } from './ChartFrame';
import type { ChartSeries } from './chart-frame-view';
import {
  chartNumberFormat,
  chartTable,
  cssPercent,
  hitEdge,
  markerPath,
  pointLabel,
  seriesStyle,
} from './chart-frame-view';
import { categoryLabels, minorTicks, tickDecimals } from './chart-ticks-view';
import styles from './LineChart.module.scss';
import type { LineLayout } from './line-chart-view';
import { LINE_CHART, lineLayout, markedPoints } from './line-chart-view';

export interface LineChartProps {
  /** The chart's name, already translated: the figure's caption and the svg's accessible name. */
  label: string;
  /** The x axis, oldest first, already formatted for display — "17 Sep", "14:00". */
  keys: readonly string[];
  /** One entry per line. `values[i]` belongs to `keys[i]`; `null` is a gap, never a zero. */
  series: readonly ChartSeries[];
  /** The key column's head in the data table, already translated — "Day". */
  keyLabel?: string | undefined;
  /** Formats every value and tick. Default: `Intl.NumberFormat` in the page's locale. */
  format?: ((value: number) => string) | undefined;
  /** Start the value axis at zero. Default on; off fits the axis to the data. */
  zero?: boolean | undefined;
  /** Give every point a tab stop and a hover/focus readout. Default off: no tab stops. */
  focusable?: boolean | undefined;
  /** Show the caption above the plot. Default off — it names the figure either way. */
  showCaption?: boolean | undefined;
  /** Lands on the root `<figure>`. */
  class?: string | undefined;
}

/** The same props: an area chart is a line chart that fills. */
export type AreaChartProps = LineChartProps;

/** Up to six value labels: at 390px a seventh crowds the ones beside it. */
const MAX_TICKS = 6;
const MARKER_RADIUS = 4;

export function LineChart(props: LineChartProps): JSX.Element {
  return xyChart(props, false);
}

export function AreaChart(props: AreaChartProps): JSX.Element {
  return xyChart(props, true);
}

function xyChart(props: LineChartProps, filled: boolean): JSX.Element {
  const ui = useUi();
  const layout = (): LineLayout =>
    lineLayout({
      keys: props.keys,
      series: props.series,
      zero: props.zero !== false,
      maxTicks: MAX_TICKS,
    });
  const format = (value: number): string => (props.format ?? chartNumberFormat(ui.locale))(value);
  const tickFormat = (value: number): string =>
    (props.format ?? chartNumberFormat(ui.locale, tickDecimals(layout().scale.step)))(value);
  const { width, height } = LINE_CHART;

  const hits = (): readonly ChartHit[] =>
    props.series.flatMap((series, s) =>
      (layout().series[s]?.points ?? []).map((point) => ({
        x: cssPercent(point.x, width),
        y: cssPercent(point.y, height),
        label: pointLabel(props.keys[point.index] ?? '', series.label, format(point.value)),
        edge: hitEdge(point.x, width),
      })),
    );

  return (
    <ChartFrame
      label={props.label}
      showCaption={props.showCaption}
      class={props.class}
      legend={
        props.series.length < 2
          ? undefined
          : props.series.map((series, s) => ({
              label: series.label,
              swatch: seriesSwatch(seriesStyle(s)),
            }))
      }
      table={chartTable({
        caption: props.label,
        keyLabel: props.keyLabel,
        keys: props.keys,
        series: props.series,
        format,
      })}
    >
      <div class={styles['chart']}>
        <div class={styles['values']} aria-hidden="true">
          {layout().ticks.map((tick, i) => (
            <span
              class={styles['tick']}
              data-tick="value"
              data-minor={minorTicks(layout().ticks.length)[i] === true ? 'true' : 'false'}
              style={{ '--at': cssPercent(tick.y, height) }}
            >
              {tickFormat(tick.value)}
            </span>
          ))}
        </div>
        <div class={styles['box']}>
          <svg
            role="img"
            aria-label={props.label}
            viewBox={`0 0 ${width} ${height}`}
            class={styles['plot']}
          >
            {layout().ticks.map((tick) => (
              <line class={styles['grid']} x1={0} x2={width} y1={tick.y} y2={tick.y} />
            ))}
            {props.series.map((_, s) => {
              const style = seriesStyle(s);
              const geometry = layout().series[s];
              if (geometry === undefined) return null;
              return (
                <g data-series={style.slot} data-line={String(s)}>
                  {filled && geometry.area !== '' ? (
                    <path class={styles['area']} d={geometry.area} data-area="true" />
                  ) : null}
                  <path class={styles['line']} d={geometry.line} stroke-dasharray={style.dash} />
                  {markedPoints(geometry.points, props.keys.length).map((point) => (
                    <path
                      class={styles['marker']}
                      d={markerPath(style.marker, point.x, point.y, MARKER_RADIUS)}
                      data-marker={style.marker}
                    />
                  ))}
                </g>
              );
            })}
          </svg>
          {props.focusable === true ? chartHits(hits()) : null}
        </div>
        <div class={styles['keys']} aria-hidden="true">
          {categoryLabels(props.keys.length).map((label) => (
            <span
              class={cx(styles['key'], styles[`edge-${label.edge}`])}
              data-tick="key"
              data-narrow={String(label.narrow)}
              data-wide={String(label.wide)}
              style={{ '--at': cssPercent(layout().keyX[label.index] ?? 0, width) }}
            >
              {props.keys[label.index]}
            </span>
          ))}
        </div>
      </div>
    </ChartFrame>
  );
}
