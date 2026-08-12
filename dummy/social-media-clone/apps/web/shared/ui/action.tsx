// The two things a reader can press, sharing one look: a link that navigates and a button that
// submits a form. Same stylesheet, because a "Sign in" that is an anchor on one page and a submit
// on the next must not be two different buttons — and the element still tells the truth about what
// pressing it does.

import type { JSX } from 'solid-js';
import styles from './action.module.scss';

export type ActionVariant = 'primary' | 'secondary';
export type ActionSize = 'md' | 'lg';

interface ActionLook {
  readonly variant?: ActionVariant | undefined;
  readonly size?: ActionSize | undefined;
}

const classOf = (look: ActionLook): string =>
  `${styles.action} ${styles[look.variant ?? 'primary']} ${styles[look.size ?? 'md']}`;

export interface ActionLinkProps extends ActionLook {
  readonly href: string;
  readonly children?: JSX.Element;
}

export function ActionLink(props: ActionLinkProps): JSX.Element {
  return (
    <a class={classOf(props)} href={props.href}>
      {props.children}
    </a>
  );
}

export interface ActionButtonProps extends ActionLook {
  readonly children?: JSX.Element;
}

/** Always `type="submit"`: nothing on `site/` hydrates, so a button that is not a submit does nothing. */
export function ActionButton(props: ActionButtonProps): JSX.Element {
  return (
    <button class={classOf(props)} type="submit">
      {props.children}
    </button>
  );
}
