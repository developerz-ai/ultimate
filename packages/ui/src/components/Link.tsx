// Anchor primitive. External links get `rel` hardening and a translated
// "opens in a new tab" hint automatically — never a bare `target="_blank"`.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Link.module.scss';

export interface LinkProps {
  href: string;
  children: JSX.Element;
  external?: boolean | undefined;
  /** Announced suffix for external links; supply via `t()` at the call site. */
  externalHint?: string | undefined;
  underline?: 'always' | 'hover' | 'none' | undefined;
  tone?: 'accent' | 'inherit' | undefined;
  id?: string | undefined;
  class?: string | undefined;
  'aria-current'?: 'page' | 'step' | 'true' | false | undefined;
  onClick?: JSX.EventHandlerUnion<HTMLAnchorElement, MouseEvent> | undefined;
}

export function Link(props: LinkProps): JSX.Element {
  const isExternal = (): boolean => props.external === true || /^https?:\/\//.test(props.href);

  return (
    <a
      id={props.id}
      href={props.href}
      target={isExternal() ? '_blank' : undefined}
      rel={isExternal() ? 'noopener noreferrer' : undefined}
      aria-current={props['aria-current']}
      class={cx(
        styles['link'],
        styles[`underline-${props.underline ?? 'hover'}`],
        styles[`tone-${props.tone ?? 'accent'}`],
        props.class,
      )}
      onClick={props.onClick}
    >
      {props.children}
      {isExternal() && props.externalHint !== undefined ? (
        <span class={styles['hint']}>{props.externalHint}</span>
      ) : null}
    </a>
  );
}
