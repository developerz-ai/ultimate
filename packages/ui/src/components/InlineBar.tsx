// A figure with a bar drawn to its share of a maximum — the in-cell bar a dashboard table uses to
// make a column of numbers scannable. The text is the fact and is what assistive tech reads; the
// bar is `Meter`'s decorative form, so the share rule and its clamping are written once.
// The figure arrives formatted, as `StatTile`'s does: this component never guesses a locale.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './InlineBar.module.scss';
import { Meter } from './Meter';
import type { Tone } from './variants';

export interface InlineBarProps {
  value: number;
  /** The whole the bar is a share of — usually the largest value in the column. */
  max: number;
  /** The figure as the cell shows it, already formatted (`Intl.NumberFormat`, `formatMoney`). */
  text: string;
  tone?: Tone | undefined;
  class?: string | undefined;
}

export function InlineBar(props: InlineBarProps): JSX.Element {
  return (
    <span class={cx(styles['inlineBar'], props.class)}>
      <span class={styles['value']} data-inline-bar-value="">
        {props.text}
      </span>
      <Meter class={styles['bar']} value={props.value} max={props.max} tone={props.tone} />
    </span>
  );
}
