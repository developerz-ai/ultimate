// A thin horizontal bar showing one value against a maximum — a table cell's "how busy is this
// row" beside the number, or a quota. Decorative by default: with no `label` it is hidden from
// the accessibility tree, because the number beside it is the fact. With one it is a `meter` role
// with the value spoken.
//
// An SVG with a `width` ATTRIBUTE rather than a styled box: it paints identically on the server
// copy and the hydrated one and asks nothing of the CSP's `style-src-attr`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Meter.module.scss';
import { meterShare, meterWidth } from './meter-view';
import type { Tone } from './variants';

export interface MeterProps {
  value: number;
  max: number;
  /** The accessible name. Omit for a purely decorative bar beside a visible number. */
  label?: string | undefined;
  tone?: Tone | undefined;
  class?: string | undefined;
}

export function Meter(props: MeterProps): JSX.Element {
  const share = (): number => meterShare(props.value, props.max);
  const classes = (): string =>
    cx(styles['meter'], styles[`tone-${props.tone ?? 'accent'}`], props.class);
  const bars = (): JSX.Element => [
    <rect class={styles['track']} width={100} height={4} rx={2} />,
    <rect class={styles['fill']} width={meterWidth(share())} height={4} rx={2} />,
  ];
  // Two literal elements rather than one with conditional ARIA: the `meter` role's value
  // attributes are only valid ON that role, and a lint that reads roles statically has to see it.
  if (props.label === undefined) {
    return (
      <svg class={classes()} viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
        {bars()}
      </svg>
    );
  }
  return (
    // A native <meter> paints its fill through a vendor pseudo-element per browser, so it cannot
    // be drawn with tokens or identically everywhere; the role goes on the SVG that draws it.
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled from tokens
    <svg
      class={classes()}
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
    >
      {bars()}
    </svg>
  );
}
