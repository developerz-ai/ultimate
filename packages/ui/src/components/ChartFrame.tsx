// The frame every chart stands in: a `<figure>` named by its `<figcaption>`, the plot, a legend
// that wraps under the plot on a narrow container and stands beside it on a wide one, and a
// visually-hidden `<table>` of the same numbers — what a screen reader and a reader who cannot
// tell the colours apart get instead of the picture. Server-rendered HTML: no island, no JS.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './ChartFrame.module.scss';
import type { ChartTable, SeriesStyle } from './chart-frame-view';
import { markerPath } from './chart-frame-view';

export interface ChartLegendItem {
  /** The series' name, already translated. */
  readonly label: string;
  /** A figure beside the name — a donut segment's value. Already formatted. */
  readonly value?: string | undefined;
  /** A second, quieter figure — the segment's share. Already formatted. */
  readonly detail?: string | undefined;
  /** The key: the same colour slot, dash and marker the plot draws this series with. */
  readonly swatch: JSX.Element;
}

/** One focusable point over the plot: where it sits, and what it reads. */
export interface ChartHit {
  /** CSS percentages of the plot box (`cssPercent`). */
  readonly x: string;
  readonly y: string;
  /** The accessible name AND the visible readout — one string, so the two never disagree. */
  readonly label: string;
  /** Which way the readout opens, so a point at the edge keeps its readout inside the box. */
  readonly edge: 'start' | 'middle' | 'end';
}

export interface ChartFrameProps {
  /** The chart's name, already translated: the `<figcaption>`, and the data table's caption. */
  label: string;
  /** The plot — the chart's own svg and HTML axis labels. */
  children: JSX.Element;
  /**
   * Show the caption above the plot. Off by default: a chart usually sits under a Card's own
   * heading, and the caption names the figure for assistive tech either way.
   */
  showCaption?: boolean | undefined;
  /** One entry per series. Omitted or empty renders no legend. */
  legend?: readonly ChartLegendItem[] | undefined;
  /** The same data as rows, rendered visually hidden (`chartTable`). */
  table?: ChartTable | undefined;
  /** Lands on the root `<figure>`. */
  class?: string | undefined;
}

export function ChartFrame(props: ChartFrameProps): JSX.Element {
  const legend = (): readonly ChartLegendItem[] => props.legend ?? [];
  return (
    <figure class={cx(styles['frame'], props.class)}>
      <figcaption class={props.showCaption === true ? styles['caption'] : styles['hidden']}>
        {props.label}
      </figcaption>
      <div class={cx(styles['layout'], legend().length > 0 && styles['withLegend'])}>
        <div class={styles['plot']}>{props.children}</div>
        {legend().length === 0 ? null : (
          <ul class={styles['legend']}>
            {legend().map((item) => (
              <li class={styles['item']}>
                <span class={styles['swatch']} aria-hidden="true">
                  {item.swatch}
                </span>
                <span class={styles['name']} data-legend="name">
                  {item.label}
                </span>
                {item.value === undefined ? null : (
                  <span class={styles['value']}>{item.value}</span>
                )}
                {item.detail === undefined ? null : (
                  <span class={styles['detail']}>{item.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.table === undefined ? null : chartTableNode(props.table)}
    </figure>
  );
}

function chartTableNode(table: ChartTable): JSX.Element {
  const [corner = '', ...heads] = table.head;
  return (
    <table class={styles['hidden']}>
      <caption>{table.caption}</caption>
      <thead>
        <tr>
          {/* An empty corner is a <td>: a header cell with no text names nothing. */}
          {corner === '' ? <td /> : <th scope="col">{corner}</th>}
          {heads.map((head) => (
            <th scope="col">{head}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr>
            <th scope="row">{row.key}</th>
            {row.cells.map((cell) => (
              <td>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A legend key for a line series: its dash, its marker, its colour slot. */
export function seriesSwatch(style: SeriesStyle): JSX.Element {
  return (
    <svg class={styles['key']} viewBox="0 0 24 12" data-series={style.slot} aria-hidden="true">
      <path class={styles['keyLine']} d="M1,6 L23,6" stroke-dasharray={style.dash} />
      <path class={styles['keyMarker']} d={markerPath(style.marker, 12, 6, 4)} />
    </svg>
  );
}

/**
 * The keyboard layer: one focusable point per datum, over the plot, each reading its own value on
 * `:hover` and `:focus-visible` — CSS only, so a chart that asks for it still ships no JS. DOM
 * order is the tab order, and the caller passes them in reading order.
 */
export function chartHits(hits: readonly ChartHit[]): JSX.Element {
  return (
    <div class={styles['hits']}>
      {hits.map((hit) => (
        // A datum is an image of one value: `img` is the role that names it and nothing more.
        <span
          class={styles['hit']}
          role="img"
          tabindex={0}
          aria-label={hit.label}
          data-hit="true"
          data-edge={hit.edge}
          style={{ '--x': hit.x, '--y': hit.y }}
        >
          {/* A zero-width anchor that centres the bubble over the point with flex, not a
              percentage translate: that one lands a whole width off under `dir="rtl"`. */}
          <span class={styles['readout']} aria-hidden="true">
            <span class={styles['bubble']} data-readout="true">
              {hit.label}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
