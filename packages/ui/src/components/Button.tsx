// The one button. Variants and tones are token-driven, so dark mode and RTL
// need no extra rules; `loading` keeps the label mounted to avoid a layout jump.
//
// `loading` does NOT set the native `disabled` attribute, and that WILL read as a mistake — it set
// one until 2026-09. Four things go wrong when a control disables itself mid-flow: the browser
// moves focus off it to `<body>`, so a keyboard user's next Tab restarts at the top of the
// document; a disabled control is exempt from WCAG's contrast minimum, so the state the user most
// needs to read is the one allowed to be unreadable; it explains nothing, because `disabled` has
// no announced reason; and it does not actually prevent the double submit, which is a race on the
// server. `aria-disabled` says unavailable and keeps the control focusable, the click is refused
// here, and the form refuses it again — `Form busy` — because the button is not the only way in.

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

type ButtonClick = Parameters<JSX.EventHandler<HTMLButtonElement, MouseEvent>>[0];

export function Button(props: ButtonProps): JSX.Element {
  const busy = (): boolean => props.loading === true;
  const inert = (): boolean => props.disabled === true || busy();

  /**
   * `aria-disabled` is advisory — it changes what is announced and nothing else — so the refusal
   * has to happen here. `preventDefault` is what stops a `type="submit"` reaching its form; not
   * calling the caller's handler is what stops everything else.
   */
  const onClick = (event: ButtonClick): void => {
    if (inert()) {
      event.preventDefault();
      return;
    }
    const handler = props.onClick;
    if (handler === undefined) return;
    // Solid's bound form is `[handler, data]`, and a component that only called the function form
    // would silently drop every `onClick={[save, id]}` in the app.
    if (typeof handler === 'function') handler(event);
    else handler[0](handler[1], event);
  };

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
      // Only the caller's explicit `disabled` reaches the attribute. `loading` is a state the user
      // is meant to read and wait out, not a control taken away from under them.
      disabled={props.disabled === true ? true : undefined}
      aria-disabled={ariaBool(inert())}
      aria-busy={ariaBool(busy())}
      aria-label={props['aria-label']}
      aria-controls={props['aria-controls']}
      aria-expanded={ariaBool(props['aria-expanded'])}
      onClick={onClick}
    >
      {busy() ? (
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
