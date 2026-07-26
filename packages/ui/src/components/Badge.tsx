// Small status label. Tone maps straight onto the status colour roles so the
// same component is legible on both themes with no per-theme override.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Badge.module.scss';
import type { Size, Tone } from './variants';

export interface BadgeProps {
  children: JSX.Element;
  tone?: Tone | undefined;
  size?: Size | undefined;
  variant?: 'soft' | 'solid' | 'outline' | undefined;
  /** Renders a leading dot; pair with a tone that carries the meaning. */
  dot?: boolean | undefined;
  class?: string | undefined;
}

export function Badge(props: BadgeProps): JSX.Element {
  return (
    <span
      class={cx(
        styles['badge'],
        styles[`tone-${props.tone ?? 'neutral'}`],
        styles[`variant-${props.variant ?? 'soft'}`],
        styles[`size-${props.size ?? 'md'}`],
        props.class,
      )}
    >
      {props.dot === true ? <span aria-hidden="true" class={styles['dot']} /> : null}
      {props.children}
    </span>
  );
}
