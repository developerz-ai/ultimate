// The top of every interior screen: an optional eyebrow, the page's one `<h1>`, a lede, and the
// controls that belong to the page rather than to a row in it.
//
// One component rather than twelve hand-written `<h1>` blocks — that is where the heading level,
// the measure and the spacing rhythm drift apart, and a reader moving between two screens sees it.

import type { JSX } from 'solid-js';
import styles from './page-heading.module.scss';

export interface PageHeadingProps {
  /** Already-translated. A short label above the title — the section a screen belongs to. */
  readonly eyebrow?: string | undefined;
  /** Already-translated. Rendered as the page's only `<h1>`. */
  readonly title: string;
  /** Already-translated supporting line. Capped to a reading measure by the stylesheet. */
  readonly lede?: string | undefined;
  readonly actions?: JSX.Element | undefined;
}

export function PageHeading(props: PageHeadingProps): JSX.Element {
  return (
    <div class={styles.heading}>
      <div class={styles.text}>
        {props.eyebrow === undefined ? null : <p class={styles.eyebrow}>{props.eyebrow}</p>}
        <h1 class={styles.title}>{props.title}</h1>
        {props.lede === undefined ? null : <p class={styles.lede}>{props.lede}</p>}
      </div>
      {props.actions === undefined ? null : <div class={styles.actions}>{props.actions}</div>}
    </div>
  );
}
