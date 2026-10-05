// The top of a screen: breadcrumbs, the page's one heading, a description, and the actions that
// belong to the page rather than to a row in it. Hand-rolled, this is where the heading level,
// the landmark and the action alignment go wrong; here it is one component with one shape.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';
import { type HeadingLevel, headingTag } from './heading-level';
import { headingNode } from './heading-node';
import styles from './PageHeader.module.scss';

export interface PageHeaderProps {
  /** Already-translated page title. Rendered as the heading, once. */
  title: string;
  /** Already-translated supporting line under the title. */
  description?: string | undefined;
  /** Trailing controls — a Button, a Toolbar. Wraps under the title on narrow viewports. */
  actions?: JSX.Element | undefined;
  breadcrumbs?: readonly BreadcrumbItem[] | undefined;
  /** Heading level. 1 by default: a screen has exactly one h1, and this is it. */
  level?: HeadingLevel | undefined;
  /** Rendered before the title — an avatar, an icon, a status dot. */
  media?: JSX.Element | undefined;
  class?: string | undefined;
}

export function PageHeader(props: PageHeaderProps): JSX.Element {
  // Resolved once, so an off-scale level throws `X_UI_INVALID_VALUE` here as it always did.
  const heading = headingTag(props.level ?? 1);
  const title = (): string => props.title;

  return (
    <header class={cx(styles['pageHeader'], props.class)}>
      {props.breadcrumbs === undefined ? null : <Breadcrumb items={props.breadcrumbs} />}
      <div class={styles['bar']}>
        <div class={styles['titles']}>
          {props.media === undefined ? null : <div class={styles['media']}>{props.media}</div>}
          <div class={styles['text']}>
            {headingNode(heading, { class: styles['title'] }, title)}
            {props.description === undefined ? null : (
              <p class={styles['description']}>{props.description}</p>
            )}
          </div>
        </div>
        {props.actions === undefined ? null : <div class={styles['actions']}>{props.actions}</div>}
      </div>
    </header>
  );
}
