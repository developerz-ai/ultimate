// A number that counts to its value. The server renders the FINAL text, so without script, under
// reduced motion and for a crawler the figure is already right; the tween is an enhancement.

import { solid, useUi } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { browserHost } from '../effect-host';
import { runCountUp } from './count-up-run';
import {
  COUNT_UP_BACKEND,
  type CountTarget,
  countFormatter,
  countMs,
  countScalar,
} from './count-up-view';

export interface CountUpProps {
  /** The final value: a number, or a `Money` (counted in minor units, formatted by currency). */
  value: CountTarget;
  from?: number | undefined;
  /** Tween length in ms; 0 shows the value at once. */
  ms?: number | undefined;
  /** `Intl.NumberFormat` options for a plain number. */
  format?: Intl.NumberFormatOptions | undefined;
  class?: string | undefined;
}

export function CountUp(props: CountUpProps): JSX.Element {
  const { locale } = useUi();
  const to = countScalar(props.value);
  const ms = countMs(props.ms);
  const format = countFormatter(props.value, locale, props.format);
  const rt = solid();
  let el: HTMLSpanElement | undefined;

  rt.createEffect(() => {
    if (el === undefined) return;
    rt.onCleanup(runCountUp(el, el, { from: props.from ?? 0, to, ms, format }, browserHost()));
  });

  return (
    <span
      ref={(node) => {
        el = node;
      }}
      class={props.class}
      data-effect-backend={COUNT_UP_BACKEND}
    >
      {format(to)}
    </span>
  );
}
