// Surface container. Elevation is a token rung, and because the shadow tokens
// are themed the same `elevation` reads correctly on light and dark.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Card.module.scss';
import type { SpaceStep } from './variants';

export type Elevation = 'flat' | 'xs' | 'sm' | 'md' | 'lg';

export interface CardProps {
  children: JSX.Element;
  header?: JSX.Element | undefined;
  footer?: JSX.Element | undefined;
  elevation?: Elevation | undefined;
  padding?: SpaceStep | undefined;
  /** Adds hover affordance. Only use when the whole card is a link/button. */
  interactive?: boolean | undefined;
  as?: 'div' | 'article' | 'section' | 'li' | undefined;
  class?: string | undefined;
}

export function Card(props: CardProps): JSX.Element {
  const Tag = props.as ?? 'div';
  return (
    <Tag
      class={cx(
        styles['card'],
        styles[`elevation-${props.elevation ?? 'sm'}`],
        props.interactive === true && styles['interactive'],
        props.class,
      )}
      style={{ '--card-padding': `var(--space-${props.padding ?? 5})` }}
    >
      {props.header === undefined ? null : <div class={styles['header']}>{props.header}</div>}
      <div class={styles['body']}>{props.children}</div>
      {props.footer === undefined ? null : <div class={styles['footer']}>{props.footer}</div>}
    </Tag>
  );
}
