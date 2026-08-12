// What a screen shows when the honest answer is "nothing here yet".
//
// This replaces `@ultimat3/ui`'s own `EmptyState`, which cannot render here: it calls `useUi()`,
// and `useUi()` needs a registered Solid runtime that a server render through the framework's inert
// JSX factory does not have (`X_UI_RUNTIME_MISSING`). Three screens reached for it and every one of
// them threw the moment its list was empty — which, on the seeded demo, is always.

import { Icon, type IconGlyph } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './empty-state.module.scss';

export interface EmptyStateProps {
  readonly glyph: IconGlyph;
  /** Already-translated. A `<p>`, not a heading: a screen has one `<h1>` and this is not it. */
  readonly title: string;
  readonly description?: string | undefined;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div class={styles.empty}>
      <span class={styles.icon} aria-hidden="true">
        <Icon glyph={props.glyph} />
      </span>
      <p class={styles.title}>{props.title}</p>
      {props.description === undefined ? null : (
        <p class={styles.description}>{props.description}</p>
      )}
    </div>
  );
}
