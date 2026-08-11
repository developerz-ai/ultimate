// A titled block inside a page. Exists so a screen's second-level structure is a labelled
// landmark with a real heading — `aria-labelledby` wired to the heading it renders — instead of
// a <div> with bold text, which is what an unassisted layout always becomes.

import type { JSX } from 'solid-js';
import { useId } from '../a11y';
import { cx } from '../cx';
import { type HeadingLevel, headingTag } from './heading-level';
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
  const Tag = props.as ?? 'section';
  const Heading = headingTag(props.level ?? 2);
  const titleId = useId('section');

  return (
    <Tag
      class={cx(styles['section'], props.class)}
      aria-labelledby={props.title === undefined ? undefined : titleId}
    >
      {props.title === undefined && props.actions === undefined ? null : (
        <div class={styles['head']}>
          <div class={styles['text']}>
            {props.title === undefined ? null : (
              <Heading id={titleId} class={styles['title']}>
                {props.title}
              </Heading>
            )}
            {props.description === undefined ? null : (
              <p class={styles['description']}>{props.description}</p>
            )}
          </div>
          {props.actions === undefined ? null : (
            <div class={styles['actions']}>{props.actions}</div>
          )}
        </div>
      )}
      <div class={styles['body']}>{props.children}</div>
    </Tag>
  );
}
