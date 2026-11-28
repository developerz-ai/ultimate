// An endless strip. The duplicate track is `aria-hidden` and `inert` (a link inside must not be
// tabbable twice); pausing and RTL are CSS, so the strip needs no script.

import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './Marquee.module.scss';
import { MARQUEE_BACKEND, marqueeVars } from './marquee-view';

export interface MarqueeProps {
  /** Called once per track: a DOM node can only live in one place. */
  children: () => JSX.Element;
  /** Seconds for one loop. */
  seconds?: number | undefined;
  reverse?: boolean | undefined;
  class?: string | undefined;
}

export function Marquee(props: MarqueeProps): JSX.Element {
  return (
    <div
      class={cx(styles['root'], props.class)}
      data-effect-backend={MARQUEE_BACKEND}
      style={marqueeVars(props.seconds, props.reverse === true)}
    >
      <div class={styles['track']}>{props.children()}</div>
      <div class={cx(styles['track'], styles['clone'])} aria-hidden="true" inert>
        {props.children()}
      </div>
    </div>
  );
}
