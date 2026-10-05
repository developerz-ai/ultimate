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
  const cls = (): string =>
    cx(
      styles['card'],
      styles[`elevation-${props.elevation ?? 'sm'}`],
      props.interactive === true && styles['interactive'],
      props.class,
    );
  const style = (): JSX.CSSProperties => ({
    '--card-padding': `var(--space-${props.padding ?? 5})`,
  });
  const header = (): JSX.Element =>
    props.header === undefined ? null : <div class={styles['header']}>{props.header}</div>;
  const body = (): JSX.Element => <div class={styles['body']}>{props.children}</div>;
  const footer = (): JSX.Element =>
    props.footer === undefined ? null : <div class={styles['footer']}>{props.footer}</div>;

  // One intrinsic per case, never `const Tag = props.as; <Tag>`: the island build compiles a
  // capitalised tag to `createComponent(Tag)` and calls the string (#488, `intrinsic-root.test.ts`).
  switch (props.as ?? 'div') {
    case 'article':
      return (
        <article class={cls()} style={style()}>
          {header()}
          {body()}
          {footer()}
        </article>
      );
    case 'section':
      return (
        <section class={cls()} style={style()}>
          {header()}
          {body()}
          {footer()}
        </section>
      );
    case 'li':
      return (
        <li class={cls()} style={style()}>
          {header()}
          {body()}
          {footer()}
        </li>
      );
    case 'div':
      return (
        <div class={cls()} style={style()}>
          {header()}
          {body()}
          {footer()}
        </div>
      );
  }
}
