// The one button. Variants and tones are token-driven, so dark mode and RTL
// need no extra rules; `loading` keeps the label mounted to avoid a layout jump.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import styles from './Button.module.scss';
import { Spinner } from './Spinner';
import type { ButtonVariant, Size, Tone } from './variants';

export interface ButtonProps {
  /** Visible label. Never hardcoded inside the component. */
  children: JSX.Element;
  variant?: ButtonVariant | undefined;
  tone?: Tone | undefined;
  size?: Size | undefined;
  type?: 'button' | 'submit' | 'reset' | undefined;
  disabled?: boolean | undefined;
  /** Blocks interaction and announces progress via `aria-busy`. */
  loading?: boolean | undefined;
  fullWidth?: boolean | undefined;
  iconStart?: JSX.Element | undefined;
  iconEnd?: JSX.Element | undefined;
  id?: string | undefined;
  class?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-controls'?: string | undefined;
  'aria-expanded'?: boolean | undefined;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined;
}

export function Button(props: ButtonProps): JSX.Element {
  const inert = (): boolean => props.disabled === true || props.loading === true;

  return (
    <button
      id={props.id}
      type={props.type ?? 'button'}
      class={cx(
        styles['button'],
        styles[`variant-${props.variant ?? 'primary'}`],
        styles[`tone-${props.tone ?? 'accent'}`],
        styles[`size-${props.size ?? 'md'}`],
        props.fullWidth === true && styles['full'],
        props.class,
      )}
      disabled={inert()}
      aria-disabled={ariaBool(inert())}
      aria-busy={ariaBool(props.loading === true)}
      aria-label={props['aria-label']}
      aria-controls={props['aria-controls']}
      aria-expanded={ariaBool(props['aria-expanded'])}
      onClick={props.onClick}
    >
      {props.loading === true ? (
        <span class={styles['spinner']}>
          <Spinner size="sm" />
        </span>
      ) : (
        props.iconStart
      )}
      <span class={styles['label']}>{props.children}</span>
      {props.iconEnd}
    </button>
  );
}
