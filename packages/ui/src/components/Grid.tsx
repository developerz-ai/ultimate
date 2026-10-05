// Grid layout primitive. The default is an intrinsic responsive grid
// (`auto-fit` + `minmax`) so most layouts need no breakpoint at all.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Grid.module.scss';
import type { SpaceStep } from './variants';

export interface GridProps {
  children: JSX.Element;
  /** Fixed track count. Omit for the intrinsic `auto-fit` behaviour. */
  columns?: number | undefined;
  /** Minimum track width for the intrinsic grid. */
  minColumn?: string | undefined;
  gap?: SpaceStep | undefined;
  rowGap?: SpaceStep | undefined;
  as?: 'div' | 'ul' | 'ol' | 'section' | undefined;
  class?: string | undefined;
}

export function Grid(props: GridProps): JSX.Element {
  const tracks = (): string =>
    props.columns === undefined
      ? `repeat(auto-fit, minmax(${props.minColumn ?? '16rem'}, 1fr))`
      : `repeat(${props.columns}, minmax(0, 1fr))`;
  const cls = (): string => cx(styles['grid'], props.class);
  const style = (): JSX.CSSProperties => ({
    '--grid-tracks': tracks(),
    '--grid-gap': `var(--space-${props.gap ?? 4})`,
    '--grid-row-gap': `var(--space-${props.rowGap ?? props.gap ?? 4})`,
  });

  // One intrinsic per case, never `const Tag = props.as; <Tag>`: the island build compiles a
  // capitalised tag to `createComponent(Tag)` and calls the string (#488, `intrinsic-root.test.ts`).
  switch (props.as ?? 'div') {
    case 'ul':
      return (
        <ul class={cls()} style={style()}>
          {props.children}
        </ul>
      );
    case 'ol':
      return (
        <ol class={cls()} style={style()}>
          {props.children}
        </ol>
      );
    case 'section':
      return (
        <section class={cls()} style={style()}>
          {props.children}
        </section>
      );
    case 'div':
      return (
        <div class={cls()} style={style()}>
          {props.children}
        </div>
      );
  }
}
