// Anchor primitive. External links get `rel` hardening and a translated
// "opens in a new tab" hint automatically — never a bare `target="_blank"`.
// `appearance="button"` is Button's look on the same anchor: a control that navigates is a link.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import buttonStyles from './Button.module.scss';
import styles from './Link.module.scss';
import { linkClasses } from './link-classes';
import { linkRel, linkTarget } from './link-target';
import type { ButtonVariant, Size, Tone } from './variants';

interface LinkBaseProps {
  href: string;
  children: JSX.Element;
  external?: boolean | undefined;
  /** Announced suffix for external links; supply via `t()` at the call site. */
  externalHint?: string | undefined;
  /** A pager's direction. Joins the hardening an external link always carries, never replaces it. */
  rel?: 'next' | 'prev' | undefined;
  id?: string | undefined;
  class?: string | undefined;
  'aria-current'?: 'page' | 'step' | 'true' | false | undefined;
  onClick?: JSX.EventHandlerUnion<HTMLAnchorElement, MouseEvent> | undefined;
}

/** Inline text — the default. */
export interface TextLinkProps extends LinkBaseProps {
  /** `button` wears Button's classes on the same `<a>`; the two looks take different props. */
  appearance?: 'link' | undefined;
  underline?: 'always' | 'hover' | 'none' | undefined;
  /** A text link: `accent` or `inherit`. A button-link: any `Tone`. */
  tone?: 'accent' | 'inherit' | undefined;
  variant?: undefined;
  size?: undefined;
  fullWidth?: undefined;
  iconStart?: undefined;
  iconEnd?: undefined;
}

/** Button's look on an anchor. There is no `href` on `<Button>`: this is that control. */
export interface ButtonLinkProps extends LinkBaseProps {
  appearance: 'button';
  /** `appearance="button"` only. */
  variant?: ButtonVariant | undefined;
  tone?: Tone | undefined;
  /** `appearance="button"` only. */
  size?: Size | undefined;
  /** `appearance="button"` only. */
  fullWidth?: boolean | undefined;
  /** `appearance="button"` only. */
  iconStart?: JSX.Element | undefined;
  /** `appearance="button"` only. */
  iconEnd?: JSX.Element | undefined;
  underline?: undefined;
}

export type LinkProps = TextLinkProps | ButtonLinkProps;

export function Link(props: LinkProps): JSX.Element {
  // Both the href and the external verdict come from ONE decision (`link-target.ts`): a
  // `javascript:` href used to be emitted verbatim AND classified internal, so it lost the
  // hardening too. A refused URL emits no `href` — inert, and still renders its text.
  const target = (): { href: string | undefined; external: boolean } =>
    linkTarget(props.href, props.external);
  const isExternal = (): boolean => target().external;

  /**
   * A button-link wraps its label exactly as `<Button>` does — the text truncates inside the
   * padding, the icons sit outside the truncated run — because the same classes on a different
   * child structure is a different button.
   */
  const content = (): JSX.Element =>
    props.appearance === 'button'
      ? [
          props.iconStart,
          <span class={buttonStyles['label']}>{props.children}</span>,
          props.iconEnd,
        ]
      : props.children;

  const classes = (): string => {
    const look = linkClasses(props);
    const sheet = look.sheet === 'button' ? buttonStyles : styles;
    return cx(...look.keys.map((key) => sheet[key]), props.class);
  };

  return (
    <a
      id={props.id}
      href={target().href}
      target={isExternal() ? '_blank' : undefined}
      rel={linkRel(isExternal(), props.rel)}
      aria-current={props['aria-current']}
      class={classes()}
      onClick={props.onClick}
    >
      {content()}
      {isExternal() && props.externalHint !== undefined ? (
        <span class={styles['hint']}>{props.externalHint}</span>
      ) : null}
    </a>
  );
}
