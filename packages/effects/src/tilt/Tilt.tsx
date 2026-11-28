// A wrapper that leans toward the pointer. Off — not merely softer — for a coarse pointer, inside
// a modal's focus trap, and whenever motion is not allowed; the angle never passes `TILT_MAX_DEG`.

import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { browserHost } from '../effect-host';
import styles from './Tilt.module.scss';
import { TILT_BACKEND, tiltCap } from './tilt-view';
import { tiltMove, tiltRest } from './tilt-wire';

export interface TiltProps {
  /** Degrees at the card's corner, capped at `TILT_MAX_DEG` (15). */
  maxAngle?: number | undefined;
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function Tilt(props: TiltProps): JSX.Element {
  const cap = tiltCap(props.maxAngle);
  return (
    <div
      class={cx(styles['tilt'], props.class)}
      data-effect-backend={TILT_BACKEND}
      onPointerMove={(event) => tiltMove(event.currentTarget, event, cap, browserHost())}
      onPointerLeave={(event) => tiltRest(event.currentTarget)}
    >
      {props.children}
    </div>
  );
}
