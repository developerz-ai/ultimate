// A surface with a highlight that follows the pointer and, for a keyboard user, the focused
// control. The highlight is CSS; the script only writes two custom properties.

import { cx } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './SpotlightCard.module.scss';
import { SPOTLIGHT_BACKEND } from './spotlight-card-view';
import { spotlightFocus, spotlightPointer } from './spotlight-wire';

export interface SpotlightCardProps {
  children?: JSX.Element | undefined;
  class?: string | undefined;
}

export function SpotlightCard(props: SpotlightCardProps): JSX.Element {
  return (
    <div
      class={cx(styles['card'], props.class)}
      data-effect-backend={SPOTLIGHT_BACKEND}
      onPointerMove={(event) => spotlightPointer(event.currentTarget, event.clientX, event.clientY)}
      onFocusIn={(event) => {
        if (event.target instanceof HTMLElement) spotlightFocus(event.currentTarget, event.target);
      }}
    >
      {props.children}
    </div>
  );
}
