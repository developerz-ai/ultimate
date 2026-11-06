// A line chart of one or more series over the same keys — signups per day, p95 per hour — and
// `AreaChart`, the same chart with each series' area filled to the baseline. SVG lines on a nice
// 1-2-5 value axis, HTML axis labels (text inside a viewBox scales to a speck on a phone), a
// legend, and a hidden data table. Every series has its own dash and marker, never colour alone.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import type { ChartHit } from './ChartFrame';
import { ChartFrame, ChartHits, ReferenceLabels, ReferenceRules, seriesSwatch } from './ChartFrame';
import { checkAt, checkSeries } from './chart-checks';
import type { ChartSeries } from './chart-frame-view';
import {
  chartNumberFormat,
  chartTable,
  cssPercent,
  hitEdge,
  hitIds,
  markerPath,
  pointLabel,
  seriesStyle,
} from './chart-frame-view';
import type { ChartReference } from './chart-reference-view';
import { referenceLines, referenceValues } from './chart-reference-view';
import { categoryLabels, minorTicks, tickDecimals } from './chart-ticks-view';
import styles from './LineChart.module.scss';
import type { LineLayout } from './line-chart-view';
import { LINE_CHART, lineLayout, lineY, markedPoints } from './line-chart-view';

export interface LineChartProps {
  /** The chart's name, already translated: the figure's caption and the svg's accessible name. */
  label: string;
  /** The x axis, oldest first, already formatted for display — "17 Sep", "14:00". */
  keys: readonly string[];
  /** One entry per line, exactly one value per key; `null` is a gap, never a zero. */
  series: readonly ChartSeries[];
  /**
   * True x positions, one per key, strictly ascending — `row.at.getTime()` for a time axis.
   * Absent, keys are evenly spaced, which is honest only for regular samples.
   */
  at?: readonly number[] | undefined;
  /** Dashed rules at a value — a target, an SLO. Each widens the axis so it stays on the plot. */
  references?: readonly ChartReference[] | undefined;
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

/** An area chart is a line chart that fills — and may stack, each series on the ones before. */
export interface AreaChartProps extends LineChartProps {
  /** Each series' band sits on the series before it; the axis reads the total. Default off. */
  stacked?: boolean | undefined;
}

/** Up to six value labels: at 390px a seventh crowds the ones beside it. */
const MAX_TICKS = 6;
const MARKER_RADIUS = 4;

export function LineChart(props: LineChartProps): JSX.Element {
  return xyChart(props, false, () => false);
}

export function AreaChart(props: AreaChartProps): JSX.Element {
  return xyChart(props, true, () => props.stacked === true);
}

function xyChart(props: LineChartProps, filled: boolean, stacked: () => boolean): JSX.Element {
  const ui = useUi();
  const layout = (): LineLayout => {
    checkSeries('LineChart', props.keys, props.series);
    if (props.at !== undefined) checkAt('LineChart', props.keys, props.at);
    return lineLayout({
      keys: props.keys,
      series: props.series,
      zero: props.zero !== false,
      maxTicks: MAX_TICKS,
      at: props.at,
      also: referenceValues(props.references),
      stacked: stacked(),
    });
  };
  const format = (value: number): string => (props.format ?? chartNumberFormat(ui.locale))(value);
  const tickFormat = (value: number): string =>
    (props.format ?? chartNumberFormat(ui.locale, tickDecimals(layout().scale.step)))(value);
  const { width, height } = LINE_CHART;

  const hits = (): readonly ChartHit[] =>
    props.series.flatMap((series, s) => {
      const ids = hitIds(s, props.keys);
      return (layout().series[s]?.points ?? []).map((point) => ({
        id: ids[point.index] ?? `${s}:${point.index}`,
        x: cssPercent(point.x, width),
        y: cssPercent(point.y, height),
        label: pointLabel(props.keys[point.index] ?? '', series.label, format(point.value)),
        edge: hitEdge(point.x, width),
      }));
    });
  const lines = () => referenceLines(props.references, (value) => lineY(layout().scale, value));

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
              swatch: seriesSwatch(seriesStyle(s), series.tone),
            }))
      }
      table={chartTable({
        caption: props.label,
        keyLabel: props.keyLabel,
        keys: props.keys,
        series: props.series,
        format,
        none: ui.t(UI_KEYS.chartNone),
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
            {props.series.map((series, s) => {
              const style = seriesStyle(s);
              const geometry = layout().series[s];
              if (geometry === undefined) return null;
              return (
                <g data-series={style.slot} data-tone={series.tone} data-line={String(s)}>
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
            <ReferenceRules lines={lines()} width={width} />
          </svg>
          <ReferenceLabels lines={lines()} height={height} format={format} />
          {props.focusable === true ? <ChartHits hits={hits()} /> : null}
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
