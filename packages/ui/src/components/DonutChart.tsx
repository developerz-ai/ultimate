// Parts of one whole — traffic by device, runs by outcome — as a ring of segments with the total
// (or the caller's figure) in its centre, a legend giving each part's value and share, and a hidden
// data table. Each segment carries its series' marker shape and a gap from its neighbours, so
// the ring reads in greyscale. SVG geometry from `donut-chart-view.ts`; text is HTML.

import type { JSX } from 'solid-js';
import { useUi } from '../theme/context';
import type { ChartHit } from './ChartFrame';
import { ChartFrame, chartHits } from './ChartFrame';
import type { MarkerShape } from './chart-frame-view';
import {
  chartNumberFormat,
  chartPercentFormat,
  chartTable,
  cssPercent,
  hitEdge,
  markerPath,
  pointLabel,
  seriesStyle,
} from './chart-frame-view';
import styles from './DonutChart.module.scss';
import type { DonutArc } from './donut-chart-view';
import { annularSector, DONUT, donutArcs } from './donut-chart-view';

export interface DonutSegment {
  /** The part's name, already translated. */
  readonly label: string;
  /** Its size; zero, negative and non-finite values are listed but not drawn. */
  readonly value: number;
}

export interface DonutChartProps {
  /** The chart's name, already translated: the figure's caption and the svg's accessible name. */
  label: string;
  /** Clockwise from twelve o'clock, in the order the legend lists them. */
  segments: readonly DonutSegment[];
  /** The figure in the ring's centre, already formatted. Default: the formatted total. */
  centreValue?: string | undefined;
  /** A short line under the centre figure, already translated — "Total", "Sessions". */
  centreLabel?: string | undefined;
  /** The segment column's head in the data table, already translated — "Device". */
  keyLabel?: string | undefined;
  /** The value column's head in the data table, already translated. Default: `label`. */
  valueLabel?: string | undefined;
  /** Formats every value. Default: `Intl.NumberFormat` in the page's locale. */
  format?: ((value: number) => string) | undefined;
  /** Give every drawn segment a tab stop and a hover/focus readout. Default off. */
  focusable?: boolean | undefined;
  /** Show the caption above the chart. Default off — it names the figure either way. */
  showCaption?: boolean | undefined;
  /** Lands on the root `<figure>`. */
  class?: string | undefined;
}

const finitePositive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

export function DonutChart(props: DonutChartProps): JSX.Element {
  const ui = useUi();
  const format = (value: number): string => (props.format ?? chartNumberFormat(ui.locale))(value);
  const percent = (share: number): string => chartPercentFormat(ui.locale)(share);
  const arcs = (): readonly DonutArc[] => donutArcs(props.segments.map((s) => s.value));
  const total = (): number => props.segments.reduce((sum, s) => sum + finitePositive(s.value), 0);
  const { size, centre, outer, inner, marker } = DONUT;

  const hits = (): readonly ChartHit[] =>
    props.segments.flatMap((segment, i) => {
      const anchor = arcs()[i]?.anchor;
      if (anchor === null || anchor === undefined) return [];
      const share = arcs()[i]?.share ?? 0;
      return [
        {
          x: cssPercent(anchor.x, size),
          y: cssPercent(anchor.y, size),
          label: pointLabel(
            segment.label,
            undefined,
            `${format(segment.value)} (${percent(share)})`,
          ),
          edge: hitEdge(anchor.x, size),
        },
      ];
    });

  return (
    <ChartFrame
      label={props.label}
      showCaption={props.showCaption}
      class={props.class}
      legend={props.segments.map((segment, i) => ({
        label: segment.label,
        value: format(segment.value),
        detail: percent(arcs()[i]?.share ?? 0),
        swatch: segmentSwatch(seriesStyle(i).slot, seriesStyle(i).marker),
      }))}
      table={chartTable({
        caption: props.label,
        keyLabel: props.keyLabel,
        keys: props.segments.map((segment) => segment.label),
        series: [
          { label: props.valueLabel ?? props.label, values: props.segments.map((s) => s.value) },
        ],
        format,
      })}
    >
      <div class={styles['donut']}>
        <svg
          role="img"
          aria-label={props.label}
          viewBox={`0 0 ${size} ${size}`}
          class={styles['ring']}
        >
          {/* The track: the empty ring a chart with nothing to total still draws. */}
          <path
            class={styles['track']}
            d={annularSector(centre, centre, outer, inner, 0, Math.PI * 2)}
          />
          {arcs().map((arc, i) => {
            if (arc.path === '') return null;
            const style = seriesStyle(i);
            return (
              <g data-series={style.slot} data-segment={String(i)}>
                <path class={styles['segment']} d={arc.path} />
                {arc.marker === null ? null : (
                  <path
                    class={styles['marker']}
                    d={markerPath(style.marker, arc.marker.x, arc.marker.y, marker)}
                    data-marker={style.marker}
                  />
                )}
              </g>
            );
          })}
        </svg>
        <p class={styles['centre']}>
          <span class={styles['total']}>{props.centreValue ?? format(total())}</span>
          {props.centreLabel === undefined ? null : (
            <span class={styles['caption']}>{props.centreLabel}</span>
          )}
        </p>
        {props.focusable === true ? chartHits(hits()) : null}
      </div>
    </ChartFrame>
  );
}

/** A legend key for a segment: its colour slot with its marker shape cut out of it. */
function segmentSwatch(slot: number, shape: MarkerShape): JSX.Element {
  return (
    <svg class={styles['key']} viewBox="0 0 12 12" data-series={slot} aria-hidden="true">
      <rect class={styles['keyBlock']} width={12} height={12} rx={2} />
      <path class={styles['keyMarker']} d={markerPath(shape, 6, 6, 3.5)} />
    </svg>
  );
}
