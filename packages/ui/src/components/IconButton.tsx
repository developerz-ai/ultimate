// A button whose only content is an icon, so `label` is mandatory: it becomes
// the accessible name and the tooltip. There is no unlabelled icon button.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './IconButton.module.scss';
import type { ButtonVariant, Size, Tone } from './variants';

export interface IconButtonProps {
  /** Required accessible name — also used as the native tooltip. */
  label: string;
  children: JSX.Element;
  variant?: ButtonVariant | undefined;
  tone?: Tone | undefined;
  size?: Size | undefined;
  disabled?: boolean | undefined;
  round?: boolean | undefined;
  id?: string | undefined;
  class?: string | undefined;
  'aria-pressed'?: boolean | undefined;
  'aria-expanded'?: boolean | undefined;
  'aria-controls'?: string | undefined;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  return (
    <button
      id={props.id}
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props['aria-pressed']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      disabled={props.disabled === true}
      class={cx(
        styles['iconButton'],
        styles[`variant-${props.variant ?? 'ghost'}`],
        styles[`tone-${props.tone ?? 'neutral'}`],
        styles[`size-${props.size ?? 'md'}`],
        props.round === true && styles['round'],
        props.class,
      )}
      onClick={props.onClick}
    >
      <span aria-hidden="true" class={styles['glyph']}>
        {props.children}
      </span>
    </button>
  );
}
