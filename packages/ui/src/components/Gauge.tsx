// One value against its maximum as a 270° dial — CPU, a quota, a queue's fill — with the reading
// in its centre and its label under it. A `meter` role carries the value for assistive tech, the
// way `Meter` does; the readout is HTML over the svg so it keeps its size on a phone.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import { ChartFrame } from './ChartFrame';
import { chartPercentFormat, cssPercent } from './chart-frame-view';
import styles from './Gauge.module.scss';
import { GAUGE, gaugeArcs } from './gauge-view';
import { meterAria, meterShare } from './meter-view';
import type { Tone } from './variants';

export interface GaugeProps {
  /** What is measured, already translated: shown under the dial, and the meter's name. */
  label: string;
  value: number;
  max: number;
  /** The fill's colour role. Default `accent`; a caller picks `warning`/`danger` by threshold. */
  tone?: Tone | undefined;
  /** The readout, from the value and max. Default: the share as a percentage in the page's locale. */
  format?: ((value: number, max: number) => string) | undefined;
  /** Lands on the root `<figure>`. */
  class?: string | undefined;
}

export function Gauge(props: GaugeProps): JSX.Element {
  const ui = useUi();
  const share = (): number => meterShare(props.value, props.max);
  const readout = (): string =>
    props.format === undefined
      ? chartPercentFormat(ui.locale)(share())
      : props.format(props.value, props.max);
  const arcs = () => gaugeArcs(share());
  return (
    <ChartFrame label={props.label} showCaption class={cx(styles['gauge'], props.class)}>
      <div class={cx(styles['dial'], styles[`tone-${props.tone ?? 'accent'}`])}>
        {/* A native <meter> paints through per-browser pseudo-elements, so it cannot be drawn
            from tokens; the role goes on the svg that draws it, as in `Meter`. */}
        {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled from tokens */}
        <svg
          class={styles['plot']}
          viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`}
          role="meter"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={meterAria(props.value, props.max).max}
          aria-valuenow={meterAria(props.value, props.max).now}
          aria-valuetext={readout()}
        >
          <path class={styles['track']} d={arcs().track} />
          {arcs().fill === '' ? null : <path class={styles['fill']} d={arcs().fill} />}
        </svg>
        {/* aria-hidden: the meter already speaks this as its value text. */}
        <span
          class={styles['readout']}
          aria-hidden="true"
          data-readout="true"
          style={{ '--centre': cssPercent(GAUGE.centre, GAUGE.height) }}
        >
          {readout()}
        </span>
      </div>
    </ChartFrame>
  );
}
