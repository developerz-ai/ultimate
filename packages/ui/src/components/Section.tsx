// A titled block inside a page. Exists so a screen's second-level structure is a labelled
// landmark with a real heading — `aria-labelledby` wired to the heading it renders — instead of
// a <div> with bold text, which is what an unassisted layout always becomes.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { type HeadingLevel, headingTag } from './heading-level';
import { headingNode } from './heading-node';
import styles from './Section.module.scss';

export interface SectionProps {
  children: JSX.Element;
  /** Already-translated section title. Omit for an unlabelled grouping. */
  title?: string | undefined;
  /** Already-translated supporting line under the title. */
  description?: string | undefined;
  /** Controls that act on this section only. */
  actions?: JSX.Element | undefined;
  /** Heading level. 2 by default — the level under a PageHeader's h1. */
  level?: HeadingLevel | undefined;
  as?: 'section' | 'article' | 'aside' | undefined;
  class?: string | undefined;
}

export function Section(props: SectionProps): JSX.Element {
  // Resolved once, so an off-scale level throws `X_UI_INVALID_VALUE` here as it always did.
  const heading = headingTag(props.level ?? 2);
  const titleId = useId('section');
  const cls = (): string => cx(styles['section'], props.class);
  const labelledBy = (): string | undefined => (props.title === undefined ? undefined : titleId);
  const title = (): string | undefined => props.title;
  const head = (): JSX.Element =>
    props.title === undefined && props.actions === undefined ? null : (
      <div class={styles['head']}>
        <div class={styles['text']}>
          {props.title === undefined
            ? null
            : headingNode(heading, { id: titleId, class: styles['title'] }, title)}
          {props.description === undefined ? null : (
            <p class={styles['description']}>{props.description}</p>
          )}
        </div>
        {props.actions === undefined ? null : <div class={styles['actions']}>{props.actions}</div>}
      </div>
    );
  const body = (): JSX.Element => <div class={styles['body']}>{props.children}</div>;

  // One intrinsic per case, never `const Tag = props.as; <Tag>`: the island build compiles a
  // capitalised tag to `createComponent(Tag)` and calls the string (#488, `intrinsic-root.test.ts`).
  switch (props.as ?? 'section') {
    case 'article':
      return (
        <article class={cls()} aria-labelledby={labelledBy()}>
          {head()}
          {body()}
        </article>
      );
    case 'aside':
      return (
        <aside class={cls()} aria-labelledby={labelledBy()}>
          {head()}
          {body()}
        </aside>
      );
    case 'section':
      return (
        <section class={cls()} aria-labelledby={labelledBy()}>
          {head()}
          {body()}
        </section>
      );
  }
}
