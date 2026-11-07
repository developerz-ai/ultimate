// One value against its maximum as a 270° dial — CPU, a quota, a queue's fill — with the reading
// in its centre and its label under it. `null` is unknown: the track alone and `ui.chart.none`,
// never an empty dial that reads as zero. Thresholds pick the tone; a target is a tick.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { ChartFrame } from './ChartFrame';
import { checkThresholds } from './chart-checks';
import { chartPercentFormat, cssPercent } from './chart-frame-view';
import styles from './Gauge.module.scss';
import type { GaugeThreshold } from './gauge-view';
import { GAUGE, gaugeArcs, gaugeTick, thresholdTone } from './gauge-view';
import { meterAria, meterShare } from './meter-view';
import type { Tone } from './variants';

export interface GaugeProps {
  /** What is measured, already translated: shown under the dial, and the meter's name. */
  label: string;
  /** `null` is unknown: the track alone, and the readout says so. */
  value: number | null;
  max: number;
  /** The fill's colour role below every threshold. Default `accent`. */
  tone?: Tone | undefined;
  /** Ascending by `at` (the value's unit): the highest one reached sets the fill's tone. */
  thresholds?: readonly GaugeThreshold[] | undefined;
  /** A tick across the ring at this value — the goal the fill is read against. */
  target?: number | undefined;
  /** The readout, from the value and max. Default: the share as a percentage in the page's locale. */
  format?: ((value: number, max: number) => string) | undefined;
  /** Lands on the root `<figure>`. */
  class?: string | undefined;
}

export function Gauge(props: GaugeProps): JSX.Element {
  const ui = useUi();
  const known = (): number | null =>
    props.value !== null && Number.isFinite(props.value) ? props.value : null;
  const share = (): number => meterShare(known() ?? 0, props.max);
  const readout = (): string => {
    const value = known();
    if (value === null) return ui.t(UI_KEYS.chartNone);
    return props.format === undefined
      ? chartPercentFormat(ui.locale)(share())
      : props.format(value, props.max);
  };
  const arcs = () => gaugeArcs(share());
  const tone = (): Tone => {
    checkThresholds('Gauge', props.thresholds ?? []);
    return thresholdTone(known(), props.thresholds, props.tone ?? 'accent');
  };
  const target = (): number | null =>
    props.target !== undefined && Number.isFinite(props.target) && props.max > 0
      ? meterShare(props.target, props.max)
      : null;
  return (
    <ChartFrame label={props.label} showCaption class={cx(styles['gauge'], props.class)}>
      <div class={cx(styles['dial'], styles[`tone-${tone()}`])} data-tone={tone()}>
        {/* A native <meter> paints through per-browser pseudo-elements, so it cannot be drawn
            from tokens; the role goes on the svg that draws it, as in `Meter`. */}
        {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled from tokens */}
        <svg
          class={styles['plot']}
          viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`}
          role="meter"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={meterAria(known() ?? 0, props.max).max}
          // `meter` requires a now; for an unknown value the text below is what is spoken.
          aria-valuenow={meterAria(known() ?? 0, props.max).now}
          aria-valuetext={readout()}
        >
          <path class={styles['track']} d={arcs().track} />
          {arcs().fill === '' || known() === null ? null : (
            <path class={styles['fill']} d={arcs().fill} />
          )}
          {target() === null ? null : (
            <path class={styles['target']} d={gaugeTick(target() ?? 0)} data-target="true" />
          )}
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
